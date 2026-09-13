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

import type { SiteAdapter, SiteMessage } from './types';
import type { Block, BlockType } from '@/rag/types';

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

function precedingRows(row: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let sibling = row.previousElementSibling;
  while (sibling) {
    if (sibling.matches(ROW_SELECTOR)) rows.push(sibling as HTMLElement);
    sibling = sibling.previousElementSibling;
  }
  return rows; // nearest-first (reverse chat order)
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

  getParagraphAround(range: Range): string {
    const block = closestRow(range.commonAncestorContainer)
      ? (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? (range.commonAncestorContainer as Element)
          : range.commonAncestorContainer.parentElement
        )?.closest(BLOCK_SELECTOR)
      : null;
    return normalizeWhitespace(block?.textContent ?? range.toString());
  },

  getUserQuestionFor(assistantMessageId: string): string | null {
    const row = allRows().find((r) => r.dataset.index === assistantMessageId);
    if (!row) return null;
    for (const candidate of precedingRows(row)) {
      const role = roleFromRow(candidate);
      if (role === 'user') return textOf(candidate, 'user');
    }
    return null;
  },

  getRecentMessages(beforeId: string, count: number): { role: 'user' | 'assistant'; text: string }[] {
    const row = allRows().find((r) => r.dataset.index === beforeId);
    if (!row) return [];
    const nearestFirst = precedingRows(row).slice(0, count);
    return nearestFirst
      .reverse() // back to chat order
      .map((r) => {
        const role = roleFromRow(r);
        return role ? { role, text: textOf(r, role) } : null;
      })
      .filter((m): m is { role: 'user' | 'assistant'; text: string } => m !== null);
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
};

/** The element that contains the whole message list — the right target to watch for new/removed messages. */
export function getTranscriptFeed(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FEED_SELECTOR);
}
