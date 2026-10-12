// The message/port contract between the content script and the background worker.
// Content opens a `chrome.runtime.connect({ name: 'explain' })` Port, sends one
// ExplainToBackground message carrying a finished prompt, and receives zero or more
// ExplainToContent messages back.

export type ExplainToBackground = {
  type: 'explain-request';
  requestId: string;
  /** The finished prompt. The content script assembles it (it owns the chat index); the background only sends it. */
  prompt: string;
};

export type ExplainToContent =
  | { type: 'explain-chunk'; requestId: string; text: string }
  | { type: 'explain-done'; requestId: string }
  | { type: 'explain-error'; requestId: string; message: string };

export const EXPLAIN_PORT_NAME = 'explain';

// The relay contract for local embedding: content script -> background (ensures the
// offscreen document exists, relays) -> offscreen document (runs the model) -> back.
// `OffscreenEmbedRequest` carries a `target` field so the offscreen document's listener
// can tell its own relayed requests apart from the content-script-facing EmbedRequest
// the background worker listens for.

export interface EmbedRequest {
  type: 'gloss-embed-request';
  texts: string[];
}

export type EmbedResult = { ok: true; vectors: number[][] } | { ok: false; error: string };

export interface OffscreenEmbedRequest {
  target: 'gloss-offscreen';
  type: 'gloss-embed-request';
  texts: string[];
}

// Sent once by the offscreen document, the instant its message listener registers —
// *before* it attempts to load transformers.js. createDocument() resolving only means
// Chrome accepted the request to create the page; it says nothing about whether the page's
// own script finished running. Waiting for this instead of trusting createDocument() means
// a crash during setup gets a specific, diagnosable error instead of the generic
// "Could not establish connection" Chrome produces when a later real request finds no
// listener at all.
export interface OffscreenReadyAnnouncement {
  target: 'gloss-offscreen-ready';
}
