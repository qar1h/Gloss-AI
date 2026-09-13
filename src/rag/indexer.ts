import { claudeAdapter, getTranscriptFeed } from '@/sites/claude';
import { getSettings } from '@/options/storage';
import { chunkMessage, CHUNKER_VERSION } from './chunker';
import { hashText } from './hash';
import {
  deleteMessage,
  getAllChunks,
  getAllMessageRecords,
  getMessageRecord,
  replaceMessage,
} from './store';
import type { MessageRecord } from './types';

const DEBOUNCE_MS = 800;
const NAVIGATION_POLL_MS = 1000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIndexPass(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runIndexPass(), DEBOUNCE_MS);
}

async function runIndexPass(): Promise<void> {
  const conversationId = claudeAdapter.getConversationId();
  if (!conversationId) return;

  for (const message of claudeAdapter.getAllMessages()) {
    if (claudeAdapter.isStreaming(message.element)) continue; // revisited once it flips to false

    const flatText = claudeAdapter.getMessageText(message.element);
    const textHash = await hashText(flatText);
    const key = `${conversationId}:${message.id}`;
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
  if ((await getSettings()).debugEnabled) await dumpChunks(conversationId);
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

  return () => {
    feedObserver.disconnect();
    clearInterval(navigationPoll);
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}
