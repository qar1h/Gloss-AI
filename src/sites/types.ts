// The contract every per-site adapter implements. All DOM/selector knowledge for a
// given chat site lives behind this interface (see src/sites/claude.ts) — nothing
// outside src/sites/ should know what a site's HTML looks like.

export interface SiteMessage {
  id: string;
  role: 'user' | 'assistant';
  element: HTMLElement;
}

export interface SiteAdapter {
  /** Find the chat message that contains the given DOM node, if any. */
  getMessageForNode(node: Node): SiteMessage | null;

  /** Extract the plain text of a message element. */
  getMessageText(el: HTMLElement): string;

  /** Extract the paragraph of text surrounding a selection range. */
  getParagraphAround(range: Range): string;

  /** Find the user message that produced the given assistant message, if any. */
  getUserQuestionFor(assistantMessageId: string): string | null;

  /** Get up to `count` messages before the given message id, in chat order. */
  getRecentMessages(beforeId: string, count: number): { role: 'user' | 'assistant'; text: string }[];

  /** Watch a message element for streaming updates. Returns an unsubscribe function. */
  watchForStreamingUpdate(el: HTMLElement, onUpdate: () => void): () => void;
}
