// One Gemini call over one Port (v10). The background replies with chunks, then a done or an
// error, but nothing guarantees it will: the service worker can be stopped, the extension
// reloaded, or the request can hang. So a call settles exactly once, whichever comes first:
// done (with the whole text), an error from the background, the connection closing from the
// background's end, or a long silence. After that, and after cancel(), everything is ignored,
// so a late message from this call can never reach a later one. The port is injected, so this
// is tested without Chrome.

import type { ExplainToBackground, ExplainToContent } from '@/messaging/types';

export interface CallPort {
  postMessage(message: ExplainToBackground): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface CallHandlers {
  onChunk(text: string): void;
  /** The whole answer (all chunks joined). Never empty: an empty answer is an error. */
  onDone(text: string): void;
  onError(message: string): void;
}

export interface ExplainCall {
  cancel(): void;
}

/** Above the worst case of the background's 429 retries (about 20 s of sleeps in total). */
export const CALL_IDLE_TIMEOUT_MS = 60_000;

export const CONNECTION_LOST_MESSAGE =
  'Lost the connection to the extension before the answer finished. Try again; if it keeps happening, reload this tab.';
export const NO_TEXT_MESSAGE = 'No explanation was returned.';
export const TIMEOUT_MESSAGE = 'No reply from Gemini for 60 seconds, so I stopped waiting. Try again.';

export function startExplainCall(
  connect: () => CallPort,
  prompt: string,
  handlers: CallHandlers,
  idleTimeoutMs: number = CALL_IDLE_TIMEOUT_MS,
): ExplainCall {
  const port = connect();
  const requestId = crypto.randomUUID();
  let settled = false;
  let text = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stopTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function settle(): boolean {
    if (settled) return false;
    settled = true;
    stopTimer();
    return true;
  }

  function fail(message: string): void {
    if (settle()) handlers.onError(message);
  }

  function armTimer(): void {
    stopTimer();
    timer = setTimeout(() => {
      if (settled) return;
      port.disconnect(); // aborts the background's fetch
      fail(TIMEOUT_MESSAGE);
    }, idleTimeoutMs);
  }

  port.onMessage.addListener((raw: unknown) => {
    const message = raw as ExplainToContent;
    if (settled || message.requestId !== requestId) return;
    armTimer();

    if (message.type === 'explain-chunk') {
      text += message.text;
      handlers.onChunk(message.text);
    } else if (message.type === 'explain-done') {
      if (text === '') fail(NO_TEXT_MESSAGE);
      else if (settle()) handlers.onDone(text);
    } else if (message.type === 'explain-error') {
      fail(message.message);
    }
  });

  // Chrome fires this only when the OTHER end closes, so our own cancel() can't trigger it.
  port.onDisconnect.addListener(() => fail(CONNECTION_LOST_MESSAGE));

  port.postMessage({ type: 'explain-request', requestId, prompt });
  armTimer();

  return {
    /** Also closes a settled call's port, so a finished call leaves nothing open behind it. */
    cancel() {
      settled = true;
      stopTimer();
      try {
        port.disconnect();
      } catch {
        // already closed from the other end
      }
    },
  };
}
