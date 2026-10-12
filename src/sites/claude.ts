// The claude.ai SiteAdapter implementation. All claude.ai-specific selectors live in
// this file and nowhere else — verified against real markup saved in fixtures/
// (fixtures/short-chat.html, fixtures/claude-user-message.html, fixtures/claude-message.html).
//
// Known shape of one message row (a `[data-testid="transcript-row"]`):
//   - `data-index`               stable-for-the-session position, used as the message id
//   - `data-perf-row`            "human" | "assistant"
//   - `data-perf-row-streaming`  "true" while the row is still being written, "false" once done
//   - `data-last-message`        "true" only on the final row in the conversation
//   User text lives at  [data-cds="UserMessage"] [data-testid="user-message"]
//   Assistant text lives at [data-cds="Prose"] [data-perf-reply-text]
//     (this correctly excludes the "Thought for Xs" status pill, which is a sibling, not a parent)

import type { QuestionLookup, RecentLookup, SiteAdapter, SiteMessage, SiteTextMessage } from './types';
import { contiguousPrecedingRun } from './contiguity';
import type { Block, BlockType } from '@/rag/types';
import { blocksToText } from '../rag/chunker'; // relative on purpose: keeps this file loadable under vitest, which has no `@/` alias

const ROW_SELECTOR = '[data-testid="transcript-row"]';
const FEED_SELECTOR = 'div[role="feed"][data-perf-region="transcript"]';
const USER_TEXT_SELECTOR = '[data-cds="UserMessage"] [data-testid="user-message"]';
const ASSISTANT_TEXT_SELECTOR = '[data-cds="Prose"] [data-perf-reply-text]';
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre';

function roleFromRow(row: HTMLElement): 'user' | 'assistant' | null {
  const perfRow = row.dataset.perfRow;
  if (perfRow === 'human') return 'user';
  if (perfRow === 'assistant') return 'assistant';
  return null;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function textOf(row: HTMLElement, role: 'user' | 'assistant'): string {
  const selector = role === 'user' ? USER_TEXT_SELECTOR : ASSISTANT_TEXT_SELECTOR;
  const contentEl = row.querySelector(selector);
  return normalizeWhitespace(contentEl?.textContent ?? '');
}

/**
 * A message's whole text for the prompt, built from the SAME blocks the chunker indexes and
 * rendered by the same function (blocksToText), so a whole message and its excerpts can't
 * drift apart. Unlike textOf (everything flattened to one line, which also glues the code
 * block's language label onto its first line), code keeps its newlines and indentation.
 * Falls back to the flat text only when the message has no recognised blocks at all.
 */
function contentOf(row: HTMLElement, role: 'user' | 'assistant'): string {
  const selector = role === 'user' ? USER_TEXT_SELECTOR : ASSISTANT_TEXT_SELECTOR;
  const contentEl = row.querySelector<HTMLElement>(selector);
  if (!contentEl) return '';
  const blocks = getBlocks(contentEl);
  return blocks.length > 0 ? blocksToText(blocks) : normalizeWhitespace(contentEl.textContent ?? '');
}

function closestRow(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
}

function allRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(ROW_SELECTOR));
}

function blockType(el: Element): BlockType {
  switch (el.tagName) {
    case 'PRE': return 'code';
    case 'BLOCKQUOTE': return 'blockquote';
    case 'LI': return 'list-item';
    case 'P': return 'paragraph';
    default: return 'heading'; // H1-H6
  }
}

function blockText(el: Element, type: BlockType): string {
  if (type === 'code') {
    return (el.textContent ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
  }
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('pre').forEach((pre) => pre.remove());
  return normalizeWhitespace(clone.textContent ?? '');
}

/**
 * Extracts ordered, typed blocks from a message's content root, de-duplicating
 * nested matches: a block is dropped if a closer ancestor also matches
 * BLOCK_SELECTOR (e.g. blockquote > p — the blockquote already owns that text),
 * except `pre`, which always wins regardless of nesting (e.g. li > pre keeps the
 * pre as its own code block; blockText() above strips any nested `pre` out of a
 * surrounding block's own text so the code isn't also duplicated there).
 */
function getBlocks(messageRoot: HTMLElement): Block[] {
  const candidates = Array.from(messageRoot.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  const kept = candidates.filter((el) => {
    if (el.tagName === 'PRE') return true;
    if (el.closest('pre')) return false;
    const ancestorBlock = el.parentElement?.closest(BLOCK_SELECTOR);
    return !(ancestorBlock && messageRoot.contains(ancestorBlock));
  });
  return kept.map((el) => {
    const type = blockType(el);
    return { type, text: blockText(el, type) };
  });
}

/** Every row before `row` in the DOM, nearest-first, whether or not it is the previous *message*. */
function domPrecedingRows(row: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let sibling = row.previousElementSibling;
  while (sibling) {
    if (sibling.matches(ROW_SELECTOR)) rows.push(sibling as HTMLElement);
    sibling = sibling.previousElementSibling;
  }
  return rows;
}

/**
 * The rows that really are the messages just before `row` in the chat, nearest-first. claude.ai
 * virtualizes long chats, so the mounted rows can be disconnected islands, and the previous row
 * in the DOM is not necessarily the previous message (seen live: 217's DOM neighbour was 126).
 * The walk stops at the first break in `data-index`, counting EVERY row, including ones this
 * adapter doesn't recognise as messages. `endsAtGap` is false only when the run reached message 0.
 */
function precedingRun(row: HTMLElement): { rows: HTMLElement[]; endsAtGap: boolean } {
  const all = [row, ...domPrecedingRows(row)];
  const run = contiguousPrecedingRun(all.map((r) => Number(r.dataset.index)));
  return { rows: all.slice(1, 1 + run.length), endsAtGap: run.endsAtGap };
}

export const claudeAdapter: SiteAdapter = {
  getMessageForNode(node: Node): SiteMessage | null {
    const row = closestRow(node);
    if (!row) return null;
    const role = roleFromRow(row);
    const id = row.dataset.index;
    if (!role || id === undefined) return null;
    return { id, role, element: row };
  },

  getMessageText(el: HTMLElement): string {
    const role = roleFromRow(el);
    if (!role) return '';
    return textOf(el, role);
  },

  getMessageContent(el: HTMLElement): string {
    const role = roleFromRow(el);
    if (!role) return '';
    return contentOf(el, role);
  },

  getParagraphAround(range: Range): string {
    const block = closestRow(range.commonAncestorContainer)
      ? (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? (range.commonAncestorContainer as Element)
          : range.commonAncestorContainer.parentElement
        )?.closest(BLOCK_SELECTOR)
      : null;
    // Same per-block text the chunker uses: a code block keeps its newlines (a flattened
    // one-line "paragraph" would not even match the selection's own line breaks).
    return block ? blockText(block, blockType(block)) : normalizeWhitespace(range.toString());
  },

  getUserQuestionFor(assistantMessageId: string): QuestionLookup {
    const row = allRows().find((r) => r.dataset.index === assistantMessageId);
    if (!row) return { message: null, status: 'not-loaded' };
    const { rows, endsAtGap } = precedingRun(row);
    for (const candidate of rows) {
      const role = roleFromRow(candidate);
      const id = candidate.dataset.index;
      if (role === 'user' && id !== undefined) {
        return { message: { id, role, text: contentOf(candidate, 'user') }, status: 'found' };
      }
    }
    return { message: null, status: endsAtGap ? 'not-loaded' : 'none' };
  },

  getRecentMessages(beforeId: string, count: number): RecentLookup {
    const row = allRows().find((r) => r.dataset.index === beforeId);
    if (!row) return { messages: [], endsAtGap: true };
    const { rows, endsAtGap } = precedingRun(row);

    const nearestFirst: SiteTextMessage[] = [];
    for (const r of rows) {
      if (nearestFirst.length >= count) break;
      const role = roleFromRow(r);
      const id = r.dataset.index;
      if (role && id !== undefined) nearestFirst.push({ id, role, text: contentOf(r, role) });
    }
    return {
      messages: nearestFirst.reverse(), // back to chat order
      endsAtGap: nearestFirst.length < count && endsAtGap,
    };
  },

  watchForStreamingUpdate(el: HTMLElement, onUpdate: () => void): () => void {
    const observer = new MutationObserver(() => onUpdate());
    observer.observe(el, {
      attributes: true,
      attributeFilter: ['data-perf-row-streaming', 'data-is-streaming'],
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  },

  getConversationId(): string | null {
    const match = location.pathname.match(/\/chat\/([^/]+)/);
    return match?.[1] ?? null;
  },

  getAllMessages(): SiteMessage[] {
    return allRows()
      .map((row) => {
        const role = roleFromRow(row);
        const id = row.dataset.index;
        return role && id !== undefined ? { id, role, element: row } : null;
      })
      .filter((m): m is SiteMessage => m !== null);
  },

  isStreaming(el: HTMLElement): boolean {
    return el.dataset.perfRowStreaming === 'true';
  },

  getLastMessagePosition(): number | null {
    const row = document.querySelector<HTMLElement>(`${ROW_SELECTOR}[data-last-message="true"]`);
    if (!row || row.dataset.index === undefined) return null;
    const n = Number(row.dataset.index);
    return Number.isNaN(n) ? null : n;
  },

  getMessageBlocks(el: HTMLElement): Block[] {
    const role = roleFromRow(el);
    if (!role) return [];
    const selector = role === 'user' ? USER_TEXT_SELECTOR : ASSISTANT_TEXT_SELECTOR;
    const contentEl = el.querySelector<HTMLElement>(selector);
    return contentEl ? getBlocks(contentEl) : [];
  },

  getUnrecognizedRowIds(): string[] {
    return allRows()
      .filter((row) => roleFromRow(row) === null || row.dataset.index === undefined)
      .map((row) => row.dataset.index ?? '(no data-index)');
  },
};

/** The element that contains the whole message list — the right target to watch for new/removed messages. */
export function getTranscriptFeed(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FEED_SELECTOR);
}
