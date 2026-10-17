// The contract every per-site adapter implements. All DOM/selector knowledge for a
// given chat site lives behind this interface (see src/sites/claude.ts) — nothing
// outside src/sites/ should know what a site's HTML looks like.

import type { Block } from '@/rag/types';
import type { OrderStatus } from '../context/types';

export interface SiteMessage {
  /**
   * The message's POSITION in the chat as a decimal integer string ("0", "1", ...) — NOT a site
   * uuid. Chunk ordering, the before/after labels in the prompt and coverage all do Number(id),
   * and Number('3af60251-...') is NaN: the prompt would still be well-formed, with the chat in
   * the wrong order and nothing logged. The indexer refuses ids that fail positionFromId
   * (src/rag/positionId.ts). A site whose DOM has only uuids must derive a position.
   */
  id: string;
  role: 'user' | 'assistant';
  element: HTMLElement;
}

/** A message read from the page: its id follows the same position contract as SiteMessage.id; its text is getMessageContent-style. */
export interface SiteTextMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** The result of looking for the user message that produced an assistant message. */
export interface QuestionLookup {
  message: SiteTextMessage | null;
  /** Why `message` is null: 'not-loaded' = the page has a gap right before it; 'none' = the chat starts there. */
  status: 'found' | 'not-loaded' | 'none';
}

/** The result of reading the messages just before a message. */
export interface RecentLookup {
  /** Contiguous with the message (no gap), chat order, oldest first. */
  messages: SiteTextMessage[];
  /** Fewer than asked for were found because the page has a gap, not because the chat starts there. */
  endsAtGap: boolean;
}

export interface SiteAdapter {
  /** Find the chat message that contains the given DOM node, if any. */
  getMessageForNode(node: Node): SiteMessage | null;

  /**
   * Extract the plain text of a message element, flattened to one line. Used as a cheap
   * change-detection key by the indexer; NOT for the prompt (it destroys code formatting).
   */
  getMessageText(el: HTMLElement): string;

  /**
   * A message's text for the prompt: built from the same blocks the chunker indexes, rendered
   * by the same function, so code keeps its newlines and indentation.
   */
  getMessageContent(el: HTMLElement): string;

  /** Extract the paragraph of text surrounding a selection range. */
  getParagraphAround(range: Range): string;

  /**
   * Find the user message that produced the given assistant message. Only rows contiguous with
   * it count: across a gap in the mounted rows (virtualization) the nearest mounted user
   * message is NOT its question, so the result says 'not-loaded' instead of guessing.
   */
  getUserQuestionFor(assistantMessageId: string): QuestionLookup;

  /**
   * Get up to `count` messages immediately before the given message id, in chat order, stopping
   * at the first gap in the mounted rows.
   */
  getRecentMessages(beforeId: string, count: number): RecentLookup;

  /** Watch a message element for streaming updates. Returns an unsubscribe function. */
  watchForStreamingUpdate(el: HTMLElement, onUpdate: () => void): () => void;

  /** The current conversation's stable id (from the URL), or null if not on a chat page. */
  getConversationId(): string | null;

  /** The element that contains the whole message list: the right target to watch for new/removed messages. */
  getTranscriptRoot(): HTMLElement | null;

  /** Attribute names whose change should trigger an index pass (for example a streaming flag). */
  readonly observedAttributes: string[];

  /** Every message currently rendered in the DOM, in chat order. */
  getAllMessages(): SiteMessage[];

  /** Whether a message is still being written (mid-stream). */
  isStreaming(el: HTMLElement): boolean;

  /** The position of the conversation's true last message, if that row is currently rendered. */
  getLastMessagePosition(): number | null;

  /** A message's content broken into ordered, typed blocks (paragraphs, headings, code, ...). */
  getMessageBlocks(el: HTMLElement): Block[];

  /**
   * Only for sites whose message positions are valid for part of a page's life (ChatGPT). A string
   * naming the numbering the current ids belong to; it changes whenever stored positions stop
   * being valid. The stored index is wiped when it differs from the one it was written under
   * (src/rag/generationGate.ts). Omit it (Claude) and the index is kept across reloads.
   */
  getIndexGeneration?(): string | null;

  /**
   * Only for sites whose message order is partly unknown. Says whether the index may be searched
   * for this message, and what the popup should tell the user. Omit it and the order is trusted.
   */
  getOrderStatus?(messageId: string): OrderStatus;

  /** Debug only: ids (or a placeholder) of DOM rows getAllMessages() couldn't recognize
   * (missing role or id) — lets the indexer log what it's silently not indexing. */
  getUnrecognizedRowIds(): string[];
}
