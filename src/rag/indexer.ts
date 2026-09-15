import { claudeAdapter, getTranscriptFeed } from '@/sites/claude';
import { getSettings, type Settings } from '@/options/storage';
import { chunkMessage, CHUNKER_VERSION } from './chunker';
import { hashText } from './hash';
import { embedTexts, EMBEDDING_VERSION } from './embedder';
import { buildEmbedInputForChunk, buildSearchQueryText } from './query';
import { searchChunks } from './search';
import {
  deleteMessage,
  getAllChunks,
  getAllEmbeddings,
  getAllMessageRecords,
  getMessageRecord,
  putEmbedding as putEmbeddingRecord,
  replaceMessage,
} from './store';
import type { Chunk, EmbeddingRecord, MessageRecord } from './types';

const DEBOUNCE_MS = 800;
const NAVIGATION_POLL_MS = 1000;
const STREAMING_STUCK_TIMEOUT_MS = 60_000;
const EMBED_BATCH_SIZE = 8;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// message key -> when it was first observed mid-stream. A real stream finishes in
// seconds; if a row is still reporting "streaming" after STREAMING_STUCK_TIMEOUT_MS, its
// data-perf-row-streaming flag is almost certainly stuck (e.g. an errored generation),
// and it's indexed anyway rather than skipped forever.
const streamingSince = new Map<string, number>();

function scheduleIndexPass(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runIndexPass(), DEBOUNCE_MS);
}

async function runIndexPass(): Promise<void> {
  const conversationId = claudeAdapter.getConversationId();
  if (!conversationId) return;

  const settings = await getSettings();

  if (settings.debugEnabled) {
    const unrecognized = claudeAdapter.getUnrecognizedRowIds();
    if (unrecognized.length > 0) {
      console.log('[highlight-explainer] rows with no recognized role/id (never indexed):', unrecognized);
    }
  }

  for (const message of claudeAdapter.getAllMessages()) {
    const key = `${conversationId}:${message.id}`;

    if (claudeAdapter.isStreaming(message.element)) {
      const firstSeen = streamingSince.get(key);
      if (firstSeen === undefined) {
        streamingSince.set(key, Date.now());
        if (settings.debugEnabled) console.log(`[highlight-explainer] skipping message ${message.id} — still streaming`);
        continue;
      }
      if (Date.now() - firstSeen < STREAMING_STUCK_TIMEOUT_MS) continue;
      if (settings.debugEnabled) {
        console.warn(
          `[highlight-explainer] message ${message.id} has looked like it's streaming for over ${STREAMING_STUCK_TIMEOUT_MS / 1000}s — indexing it anyway`,
        );
      }
    } else {
      streamingSince.delete(key);
    }

    const flatText = claudeAdapter.getMessageText(message.element);
    const textHash = await hashText(flatText);
    const existing = await getMessageRecord(key);

    const unchanged =
      existing !== undefined &&
      existing.textHash === textHash &&
      existing.chunkerVersion === CHUNKER_VERSION;
    if (unchanged) continue;

    const blocks = claudeAdapter.getMessageBlocks(message.element);
    const chunks = await chunkMessage(conversationId, message.id, message.role, blocks);
    const record: MessageRecord = {
      key,
      conversationId,
      messageId: message.id,
      position: Number(message.id),
      role: message.role,
      textHash,
      chunkerVersion: CHUNKER_VERSION,
      chunkIds: chunks.map((c) => c.id),
      lastIndexedAt: Date.now(),
    };
    await replaceMessage(record, chunks, existing?.chunkIds ?? []);

    // Yield back to the browser between messages so a big first-time backlog
    // (opening a long chat for the first time) doesn't block the page for long.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await cleanupStaleTail(conversationId);
  await embedPendingChunks(conversationId);
  if (settings.debugEnabled) await dumpChunks(conversationId);
}

/**
 * If the conversation's true last message is currently rendered, delete any
 * indexed message (and its chunks) at a position beyond it — this is what
 * catches a branch shortened by editing an earlier message and regenerating.
 * If the last-message row isn't rendered right now (e.g. scrolled up in a long,
 * virtualized chat), we don't know the true length, so we skip rather than risk
 * deleting real history that just isn't mounted at the moment.
 */
async function cleanupStaleTail(conversationId: string): Promise<void> {
  const lastPosition = claudeAdapter.getLastMessagePosition();
  if (lastPosition === null) return;

  const records = await getAllMessageRecords(conversationId);
  const stale = records.filter((r) => r.position > lastPosition);
  for (const record of stale) await deleteMessage(record);
}

function needsEmbedding(chunk: Chunk, existing: EmbeddingRecord | undefined): boolean {
  if (!existing) return true;
  if (existing.status === 'failed') return true;
  if (existing.embeddingVersion !== EMBEDDING_VERSION) return true;
  if (existing.chunkTextHash !== chunk.textHash) return true;
  return false;
}

/**
 * Embeds every chunk in the conversation that's new, changed, on a stale model version,
 * or previously failed. Batches multiple chunks per round trip to the offscreen document
 * (one round trip per chunk would be far slower), and yields between batches for the same
 * reason the per-message chunking loop above does.
 */
async function embedPendingChunks(conversationId: string): Promise<void> {
  const chunks = await getAllChunks(conversationId);
  const existingEmbeddings = await getAllEmbeddings(conversationId);
  const existingByChunkId = new Map(existingEmbeddings.map((e) => [e.chunkId, e]));

  const chunksByMessage = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const list = chunksByMessage.get(chunk.messageId) ?? [];
    list.push(chunk);
    chunksByMessage.set(chunk.messageId, list);
  }
  for (const list of chunksByMessage.values()) list.sort((a, b) => a.chunkIndex - b.chunkIndex);

  const pending = chunks.filter((c) => needsEmbedding(c, existingByChunkId.get(c.id)));

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const inputs = batch.map((chunk) => {
      const siblings = chunksByMessage.get(chunk.messageId) ?? [];
      const index = siblings.findIndex((c) => c.id === chunk.id);
      const previous = index > 0 ? siblings[index - 1]!.text : null;
      const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1]!.text : null;
      return buildEmbedInputForChunk(chunk.text, previous, next);
    });

    try {
      const vectors = await embedTexts(inputs);
      await Promise.all(
        batch.map((chunk, idx) =>
          putEmbeddingRecord({
            chunkId: chunk.id,
            conversationId,
            vector: vectors[idx]!,
            embeddingVersion: EMBEDDING_VERSION,
            chunkTextHash: chunk.textHash,
            status: 'done',
            embeddedAt: Date.now(),
          }),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown embedding error.';
      console.warn('[highlight-explainer] failed to embed a batch of chunks, will retry next pass:', message);
      await Promise.all(
        batch.map((chunk) =>
          putEmbeddingRecord({
            chunkId: chunk.id,
            conversationId,
            vector: [],
            embeddingVersion: EMBEDDING_VERSION,
            chunkTextHash: chunk.textHash,
            status: 'failed',
            embeddedAt: Date.now(),
          }),
        ),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function dumpChunks(conversationId: string): Promise<void> {
  const chunks = await getAllChunks(conversationId);
  console.table(
    chunks.map((c) => ({
      messageId: c.messageId,
      chunkIndex: c.chunkIndex,
      role: c.role,
      wordCount: c.wordCount,
      hasCode: c.hasCode,
      preview: c.text.slice(0, 80),
    })),
  );
}

async function dumpSearch(conversationId: string, text: string, k: number): Promise<void> {
  const queryText = buildSearchQueryText(text, text);
  const [queryVector] = await embedTexts([queryText]);
  const results = await searchChunks(conversationId, queryVector!, k);

  console.table(
    results.map(({ chunk, score }) => ({
      score: score.toFixed(4),
      role: chunk.role,
      messageId: chunk.messageId,
      chunkIndex: chunk.chunkIndex,
      wordCount: chunk.wordCount,
      hasCode: chunk.hasCode,
      preview: chunk.text.slice(0, 80),
    })),
  );

  const lastPosition = claudeAdapter.getLastMessagePosition();
  const indexedCount = new Set((await getAllMessageRecords(conversationId)).map((r) => r.position)).size;
  if (lastPosition !== null) {
    console.log(
      `[highlight-explainer] indexed ${indexedCount} of ~${lastPosition + 1} messages in this chat — scroll through more of it to include it in search.`,
    );
  } else {
    console.log(
      `[highlight-explainer] indexed ${indexedCount} messages in this chat (true chat length unknown — the last message isn't currently rendered).`,
    );
  }
}

export function initIndexer(): () => void {
  let observedFeed: HTMLElement | null = null;
  const feedObserver = new MutationObserver(() => scheduleIndexPass());

  const attachToFeed = () => {
    const feed = getTranscriptFeed();
    if (feed && feed !== observedFeed) {
      feedObserver.disconnect();
      feedObserver.observe(feed, {
        attributes: true,
        attributeFilter: ['data-perf-row-streaming', 'data-last-message'],
        childList: true,
        subtree: true,
        characterData: true,
      });
      observedFeed = feed;
      scheduleIndexPass();
    }
  };

  let lastConversationId = claudeAdapter.getConversationId();
  attachToFeed();
  scheduleIndexPass();

  // claude.ai is a single-page app: the URL (and the feed element) can change
  // without a full page reload, and there's no reliable DOM event for that, so
  // a cheap poll is the pragmatic choice here over hooking history/pushState.
  const navigationPoll = setInterval(() => {
    const id = claudeAdapter.getConversationId();
    if (id !== lastConversationId) {
      lastConversationId = id;
      scheduleIndexPass();
    }
    attachToFeed(); // also covers the feed element itself being remounted
  }, NAVIGATION_POLL_MS);

  (window as unknown as { __glossDumpChunks?: () => Promise<void> }).__glossDumpChunks = async () => {
    const id = claudeAdapter.getConversationId();
    if (id) await dumpChunks(id);
  };

  (window as unknown as { __glossSearch?: (text: string, k?: number) => Promise<void> }).__glossSearch = async (
    text: string,
    k?: number,
  ) => {
    const id = claudeAdapter.getConversationId();
    if (!id) return;
    const settings: Settings = await getSettings();
    await dumpSearch(id, text, k ?? settings.retrievalK);
  };

  return () => {
    feedObserver.disconnect();
    clearInterval(navigationPoll);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
