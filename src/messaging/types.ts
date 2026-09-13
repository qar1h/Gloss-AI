// The message/port contract between the content script and the background worker.
// Content opens a `chrome.runtime.connect({ name: 'explain' })` Port, sends one
// ExplainToBackground message, and receives zero or more ExplainToContent messages back.

export interface ExplainContext {
  highlight: string;
  paragraph: string;
  message: { role: 'user' | 'assistant'; text: string };
  userQuestion: string;
  recentMessages: { role: 'user' | 'assistant'; text: string }[];
}

export type ExplainToBackground = {
  type: 'explain-request';
  requestId: string;
  context: ExplainContext;
};

export type ExplainToContent =
  | { type: 'explain-chunk'; requestId: string; text: string }
  | { type: 'explain-done'; requestId: string }
  | { type: 'explain-error'; requestId: string; message: string };

export const EXPLAIN_PORT_NAME = 'explain';
