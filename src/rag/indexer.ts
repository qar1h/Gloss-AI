import { requireAdapter } from '@/sites';
import type { SiteMessage } from '@/sites/types';
import { getSettings, type Settings } from '@/options/storage';
import { chunkMessage, CHUNKER_VERSION } from './chunker';
import { hashText } from './hash';
import { positionFromId } from './positionId';
import { ensureIndexGeneration, onIndexWiped } from './generation';
import { embedTexts, EMBEDDING_VERSION } from './embedder';
import { buildEmbedInputForChunk, buildSearchQueryText } from './query';
import { searchChunks } from './search';
import { RRF_DEPTH } from './fusion';
import { getCoverage } from './coverage';
import { describeCoverageForConsole } from '@/context/report';
import { buildDebugRows, describeLists, hybridSearch } from './hybrid';
import {
  deleteEmbedding,
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
// How many times in a row one chunk may fail to embed before it's left alone. A failure
// that isn't transient (a model that won't load, a chunk the runtime chokes on) would
// otherwise re-run real inference on every pass, forever.
const MAX_EMBED_ATTEMPTS = 3;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// A pass now includes embedding, which can take a long time (first-run model download, or
// inference over a big backlog). claude.ai's DOM mutates constantly while an answer
// streams, so without this guard a second pass would start on top of a running one and both
// would embed the same chunks. A mutation that arrives mid-pass isn't dropped: it sets
// `rerunRequested`, and one more debounced pass runs after the current one finishes.
let passInFlight: Promise<void> | null = null;
let rerunRequested = false;

// message key -> when it was first observed mid-stream. A real stream finishes in
// seconds; if a row is still reporting "streaming" after STREAMING_STUCK_TIMEOUT_MS, its
// data-perf-row-streaming flag is almost certainly stuck (e.g. an errored generation),
// and it's indexed anyway rather than skipped forever.
const streamingSince = new Map<string, number>();

function scheduleIndexPass(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => startIndexPass(), DEBOUNCE_MS);
}

function startIndexPass(): void {
  if (passInFlight) {
    rerunRequested = true;
    return;
  }
  rerunRequested = false;
  passInFlight = runIndexPass()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[highlight-explainer] indexing pass failed:', message);
    })
    .finally(() => {
      passInFlight = null;
      if (rerunRequested) {
        rerunRequested = false;
        scheduleIndexPass();
      }
    });
}

/** One indexing pass. Exported only so tests can drive it; in the extension it runs from the debounced observer. */
export async function runIndexPass(): Promise<void> {
  const settings = await getSettings();

  // Everything about the page is read here, in one tick, after the last await so far: which chat
  // this is, its messages, and which numbering they carry. Read the chat before an await and the
  // messages after it, and a navigation in between files one chat's messages under another's id.
  // (Reading the page can renumber a site whose positions are session-scoped, so the generation
  // is asked for after the messages.) Rows written under another numbering are wiped before we
  // write under this one (see generationGate.ts).
  const adapter = requireAdapter();
  const conversationId = adapter.getConversationId();
  if (!conversationId) return;

  if (settings.debugEnabled) {
    const unrecognized = adapter.getUnrecognizedRowIds();
    if (unrecognized.length > 0) {
      console.log('[highlight-explainer] rows with no recognized role/id (never indexed):', unrecognized);
    }
  }

  const messages = adapter.getAllMessages();
  const generation = adapter.getIndexGeneration?.() ?? null;
  await ensureIndexGeneration(conversationId, generation);
  const renumbered = () => (adapter.getIndexGeneration?.() ?? null) !== generation;
  // A virtualized list can hand an element to another turn while this pass awaits (see SiteAdapter).
  const stillThere = (message: SiteMessage) => adapter.isMessageCurrent?.(message) ?? true;

  const warnedBadIds = new Set<string>();
  for (const message of messages) {
    // The numbering changed while this pass was running: what we hold is numbered under the old
    // one, and writing it now would mix two numberings. Drop the pass; a fresh one is queued.
    if (renumbered()) {
      scheduleIndexPass();
      return;
    }
    // The id must be a position (see positionId.ts). A uuid here would write NaN positions and
    // scramble chat order without any error, so refuse it, loudly, once per pass.
    const position = positionFromId(message.id);
    if (position === null) {
      if (!warnedBadIds.has(message.id)) {
        warnedBadIds.add(message.id);
        console.warn(`[highlight-explainer] not indexing a message whose id is not a position: ${JSON.stringify(message.id)}`);
      }
      continue;
    }
    const key = `${conversationId}:${message.id}`;
    if (!stillThere(message)) continue;

    if (requireAdapter().isStreaming(message.element)) {
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

    const flatText = requireAdapter().getMessageText(message.element);
    const textHash = await hashText(flatText);
    const existing = await getMessageRecord(key);

    const unchanged =
      existing !== undefined &&
      existing.textHash === textHash &&
      existing.chunkerVersion === CHUNKER_VERSION;
    if (unchanged) continue;
    if (!stillThere(message)) continue; // the awaits above are long enough for the element to be reused

    const blocks = requireAdapter().getMessageBlocks(message.element);
    const chunks = await chunkMessage(conversationId, message.id, message.role, blocks);
    const record: MessageRecord = {
      key,
      conversationId,
      messageId: message.id,
      position,
      role: message.role,
      textHash,
      chunkerVersion: CHUNKER_VERSION,
      chunkIds: chunks.map((c) => c.id),
      lastIndexedAt: Date.now(),
    };
    const previousChunkIds = existing?.chunkIds ?? [];
    if (renumbered()) {
      scheduleIndexPass();
      return;
    }
    if (!stillThere(message)) continue;
    // No record means whatever this tab remembers about these chunk ids is stale: another tab (or a
    // wipe) deleted the rows, and a cached "already embedded" would keep the new chunks from ever
    // getting a vector. (The first version of the two-tab fix caused exactly this.)
    if (existing === undefined) {
      forgetEmbeddingStatuses(
        conversationId,
        chunks.map((c) => c.id),
      );
    }
    await replaceMessage(record, chunks, previousChunkIds);
    // replaceMessage drops the embedding rows of chunk ids this message no longer has —
    // drop them from the status cache too, so it stays a true picture of the store.
    const newChunkIds = new Set(record.chunkIds);
    forgetEmbeddingStatuses(
      conversationId,
      previousChunkIds.filter((id) => !newChunkIds.has(id)),
    );

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
  const lastPosition = requireAdapter().getLastMessagePosition();
  if (lastPosition === null) return;

  const records = await getAllMessageRecords(conversationId);
  const stale = records.filter((r) => r.position > lastPosition);
  for (const record of stale) {
    await deleteMessage(record);
    forgetEmbeddingStatuses(conversationId, record.chunkIds);
  }
}

/**
 * Just enough of an EmbeddingRecord to decide whether a chunk still needs embedding —
 * deliberately without the 384-number `vector`, which is the whole point of the cache below.
 */
type EmbeddingStatus = Pick<
  EmbeddingRecord,
  'embeddingVersion' | 'chunkTextHash' | 'status' | 'failureCount'
>;

// getAllEmbeddings() returns every stored vector too, which is several MB on a long
// conversation — far too much to deserialize out of IndexedDB on every debounced pass just
// to answer "what still needs embedding?". So the lightweight status of each chunk is read
// from IndexedDB once per conversation and then kept in sync in memory on every write. It's
// a cache of our own writes, not of someone else's: the only code that writes this store is
// this file (plus the deletes in store.ts, mirrored by forgetEmbeddingStatuses below), and
// on an extension reload the module state is gone, so the next pass repopulates from a
// fresh read rather than starting out silently stale.
let statusCacheConversationId: string | null = null;
let statusCache = new Map<string, EmbeddingStatus>();

// A wipe (generationGate) deletes the embedding rows this cache describes.
onIndexWiped((conversationId) => {
  if (statusCacheConversationId === conversationId) {
    statusCache = new Map();
    statusCacheConversationId = null;
  }
});

function toEmbeddingStatus(record: EmbeddingRecord): EmbeddingStatus {
  return {
    embeddingVersion: record.embeddingVersion,
    chunkTextHash: record.chunkTextHash,
    status: record.status,
    // Records written before failureCount existed don't carry one.
    failureCount: record.failureCount ?? 0,
  };
}

async function getEmbeddingStatuses(conversationId: string): Promise<Map<string, EmbeddingStatus>> {
  if (statusCacheConversationId === conversationId) return statusCache;
  const records = await getAllEmbeddings(conversationId);
  statusCache = new Map(records.map((r) => [r.chunkId, toEmbeddingStatus(r)]));
  statusCacheConversationId = conversationId;
  return statusCache;
}

/** Write an embedding row and keep the in-memory status cache in step with it. */
async function writeEmbedding(record: EmbeddingRecord): Promise<void> {
  await putEmbeddingRecord(record);
  if (statusCacheConversationId === record.conversationId) {
    statusCache.set(record.chunkId, toEmbeddingStatus(record));
  }
}

/** Mirror store.ts's embedding deletes, so the cache can't claim a chunk is already
 * embedded when its row has actually been deleted from IndexedDB. */
function forgetEmbeddingStatuses(conversationId: string, chunkIds: string[]): void {
  if (statusCacheConversationId !== conversationId) return;
  for (const id of chunkIds) statusCache.delete(id);
}

function needsEmbedding(chunk: Chunk, existing: EmbeddingStatus | undefined): boolean {
  if (!existing) return true;
  // A new model version or changed chunk text is a genuinely fresh situation, not a repeat
  // of the same failure, so it's always retried (and resets the failure count on write).
  if (existing.embeddingVersion !== EMBEDDING_VERSION) return true;
  if (existing.chunkTextHash !== chunk.textHash) return true;
  if (existing.status === 'failed') return existing.failureCount < MAX_EMBED_ATTEMPTS;
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
  const statuses = await getEmbeddingStatuses(conversationId);

  const chunksByMessage = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const list = chunksByMessage.get(chunk.messageId) ?? [];
    list.push(chunk);
    chunksByMessage.set(chunk.messageId, list);
  }
  for (const list of chunksByMessage.values()) list.sort((a, b) => a.chunkIndex - b.chunkIndex);

  const pending = chunks.filter((c) => needsEmbedding(c, statuses.get(c.id)));

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
          writeEmbedding({
            chunkId: chunk.id,
            conversationId,
            vector: vectors[idx]!,
            embeddingVersion: EMBEDDING_VERSION,
            chunkTextHash: chunk.textHash,
            status: 'done',
            failureCount: 0,
            embeddedAt: Date.now(),
          }),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown embedding error.';
      let exhausted = 0;
      await Promise.all(
        batch.map((chunk) => {
          // Only count repeats of the *same* attempt: a different chunk hash or embedding
          // version is a fresh situation and starts the count over.
          const previous = statuses.get(chunk.id);
          const sameAttempt =
            previous !== undefined &&
            previous.status === 'failed' &&
            previous.embeddingVersion === EMBEDDING_VERSION &&
            previous.chunkTextHash === chunk.textHash;
          const failureCount = (sameAttempt ? previous.failureCount : 0) + 1;
          if (failureCount >= MAX_EMBED_ATTEMPTS) exhausted++;
          return writeEmbedding({
            chunkId: chunk.id,
            conversationId,
            vector: [],
            embeddingVersion: EMBEDDING_VERSION,
            chunkTextHash: chunk.textHash,
            status: 'failed',
            failureCount,
            embeddedAt: Date.now(),
          });
        }),
      );
      console.warn(
        `[highlight-explainer] failed to embed a batch of ${batch.length} chunk(s): ${message}` +
          (exhausted > 0
            ? ` — ${exhausted} of them have now failed ${MAX_EMBED_ATTEMPTS} times and won't be retried until their text or the embedding version changes.`
            : ' — will retry next pass.'),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Debug command: delete every 'failed' embedding record for the current conversation, so
 * needsEmbedding() treats those chunks as brand new on the next pass instead of refusing to
 * retry them once failureCount has hit MAX_EMBED_ATTEMPTS. Deliberately scoped to 'failed'
 * records only — a 'done' embedding is never touched by this. Triggers an immediate pass
 * afterward rather than waiting for the next organic DOM mutation.
 */
async function resetFailedEmbeddings(conversationId: string): Promise<number> {
  const records = await getAllEmbeddings(conversationId);
  const failed = records.filter((r) => r.status === 'failed');
  for (const record of failed) await deleteEmbedding(record.chunkId);
  forgetEmbeddingStatuses(
    conversationId,
    failed.map((r) => r.chunkId),
  );
  return failed.length;
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

  console.log(`[highlight-explainer] ${describeCoverageForConsole(await getCoverage(conversationId))}`);
}

/**
 * v4 debug command: embedding ranking, BM25 ranking and the fused ranking side by side.
 * With no `text` it uses the current page selection and the real paragraph around it (what
 * an Explain click would use). With `text` it behaves like a typed highlight. The BM25
 * query is the highlight only; the embedding query is the same one v3 builds.
 */
async function dumpHybrid(conversationId: string, text?: string, k?: number, depth?: number): Promise<void> {
  const settings: Settings = await getSettings();
  const effectiveK = k ?? settings.retrievalK;
  const effectiveDepth = depth ?? RRF_DEPTH;

  let highlight: string;
  let paragraph: string;
  let ownMessageIds: Set<string>;

  if (text !== undefined) {
    highlight = text;
    paragraph = text;
    // No real source message for typed text, so "own" = every message that contains it.
    const chunks = await getAllChunks(conversationId);
    ownMessageIds = new Set(chunks.filter((c) => c.text.includes(text)).map((c) => c.messageId));
  } else {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !selection.toString().trim()) {
      console.warn('[highlight-explainer] select some text in a message first, or pass text: __glossHybrid("text")');
      return;
    }
    const range = selection.getRangeAt(0);
    highlight = selection.toString().trim();
    paragraph = requireAdapter().getParagraphAround(range);
    const message = requireAdapter().getMessageForNode(range.commonAncestorContainer);
    ownMessageIds = new Set(message ? [message.id] : []);
  }

  let queryVector: number[] | null = null;
  try {
    const [vector] = await embedTexts([buildSearchQueryText(highlight, paragraph)]);
    queryVector = vector ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[highlight-explainer] could not embed the query (${message}) — showing BM25 only.`);
  }

  const ranking = await hybridSearch(conversationId, queryVector, highlight, effectiveDepth);

  console.log(
    `[highlight-explainer] BM25 query terms: ${ranking.queryTerms.length > 0 ? ranking.queryTerms.join(', ') : 'none — BM25 abstained, embedding only'}`,
  );
  console.log(`[highlight-explainer] ${describeLists(ranking, effectiveDepth)}`);
  console.table(buildDebugRows(ranking, effectiveK, ownMessageIds));

  console.log(`[highlight-explainer] ${describeCoverageForConsole(await getCoverage(conversationId))}`);
}

export function initIndexer(): () => void {
  let observedFeed: HTMLElement | null = null;
  const feedObserver = new MutationObserver(() => scheduleIndexPass());

  const attachToFeed = () => {
    const adapter = requireAdapter();
    const feed = adapter.getTranscriptRoot();
    if (feed && feed !== observedFeed) {
      feedObserver.disconnect();
      feedObserver.observe(feed, {
        attributes: true,
        attributeFilter: adapter.observedAttributes,
        childList: true,
        subtree: true,
        characterData: true,
      });
      observedFeed = feed;
      scheduleIndexPass();
    }
  };

  let lastConversationId = requireAdapter().getConversationId();
  attachToFeed();
  scheduleIndexPass();

  // claude.ai is a single-page app: the URL (and the feed element) can change
  // without a full page reload, and there's no reliable DOM event for that, so
  // a cheap poll is the pragmatic choice here over hooking history/pushState.
  const navigationPoll = setInterval(() => {
    const id = requireAdapter().getConversationId();
    if (id !== lastConversationId) {
      lastConversationId = id;
      scheduleIndexPass();
    }
    attachToFeed(); // also covers the feed element itself being remounted
  }, NAVIGATION_POLL_MS);

  // The console helpers read the index too, so they go through the same gate as everything else:
  // between a renumbering and the next pass they would otherwise print rows from the old numbering.
  const readableConversation = async (): Promise<string | null> => {
    const adapter = requireAdapter();
    const id = adapter.getConversationId();
    if (!id) return null;
    await ensureIndexGeneration(id, adapter.getIndexGeneration?.() ?? null);
    return id;
  };

  (window as unknown as { __glossDumpChunks?: () => Promise<void> }).__glossDumpChunks = async () => {
    const id = await readableConversation();
    if (id) await dumpChunks(id);
  };

  (window as unknown as { __glossSearch?: (text: string, k?: number) => Promise<void> }).__glossSearch = async (
    text: string,
    k?: number,
  ) => {
    const id = await readableConversation();
    if (!id) return;
    const settings: Settings = await getSettings();
    await dumpSearch(id, text, k ?? settings.retrievalK);
  };

  (window as unknown as { __glossHybrid?: (text?: string, k?: number, depth?: number) => Promise<void> }).__glossHybrid =
    async (text?: string, k?: number, depth?: number) => {
      const id = await readableConversation();
      if (!id) return;
      await dumpHybrid(id, text, k, depth);
    };

  (window as unknown as { __glossResetFailedEmbeddings?: () => Promise<void> }).__glossResetFailedEmbeddings =
    async () => {
      const id = await readableConversation();
      if (!id) return;
      const count = await resetFailedEmbeddings(id);
      console.log(`[highlight-explainer] cleared ${count} failed embedding(s) — re-indexing now.`);
      scheduleIndexPass();
    };

  return () => {
    feedObserver.disconnect();
    clearInterval(navigationPoll);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
