// Relays embed requests from the content script to the offscreen document, creating that
// document lazily on first use and leaving it open afterward (reloading the model on every
// batch would be far slower than just keeping the document alive).

import type { EmbedRequest, EmbedResult, OffscreenEmbedRequest, OffscreenReadyAnnouncement } from '@/messaging/types';

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';
// Generous on purpose: the first-ever creation can overlap with the ~23MB model download if
// the offscreen document's dynamic import of transformers.js races ahead, but the readiness
// broadcast itself only waits on the document's own bare script finishing — which should be
// near-instant. This mostly exists to turn "hangs forever" into "fails with a clear reason."
const OFFSCREEN_READY_TIMEOUT_MS = 10_000;

let creatingOffscreenDocument: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

function isOffscreenReadyAnnouncement(message: unknown): message is OffscreenReadyAnnouncement {
  return (message as Partial<OffscreenReadyAnnouncement>)?.target === 'gloss-offscreen-ready';
}

/**
 * Waits for the offscreen document to announce itself (see offscreen/main.ts). This is
 * deliberately NOT "trust that createDocument()'s promise resolving means the document is
 * usable" — that promise only means Chrome accepted the request to create the page, not that
 * the page's own script finished running. A document that crashes during its own setup
 * (before ever registering a message listener) would otherwise look identical, from here, to
 * one that's slow — both just fail the next real sendMessage with Chrome's generic "Could not
 * establish connection. Receiving end does not exist." This gives that failure mode a
 * specific, diagnosable error instead.
 *
 * Must be called (to start listening) BEFORE createDocument(), not after — otherwise a
 * document that announces itself quickly could broadcast before anyone is listening for it.
 */
function waitForOffscreenReady(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.runtime.onMessage.removeListener(listener);
      reject(
        new Error(
          'The offscreen document never reported ready. It was likely created but crashed during its own ' +
            'startup — check its console via chrome://extensions → Highlight Explainer → Inspect views → offscreen.html.',
        ),
      );
    }, timeoutMs);

    function listener(raw: unknown): undefined {
      if (!isOffscreenReadyAnnouncement(raw)) return undefined;
      clearTimeout(timer);
      browser.runtime.onMessage.removeListener(listener);
      resolve();
      return undefined;
    }

    browser.runtime.onMessage.addListener(listener);
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    const ready = waitForOffscreenReady(OFFSCREEN_READY_TIMEOUT_MS);
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS], // confirmed valid against Chrome's offscreen API docs
        justification: 'Runs a local ONNX embedding model (transformers.js) to compute chunk vectors.',
      })
      .then(() => ready);
  }
  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

function isContentEmbedRequest(message: unknown): message is EmbedRequest {
  const m = message as Partial<EmbedRequest> & { target?: unknown };
  return m.type === 'gloss-embed-request' && Array.isArray(m.texts) && m.target === undefined;
}

export async function handleEmbedRequest(texts: string[]): Promise<EmbedResult> {
  try {
    await ensureOffscreenDocument();
    const request: OffscreenEmbedRequest = { target: 'gloss-offscreen', type: 'gloss-embed-request', texts };
    return (await browser.runtime.sendMessage(request)) as EmbedResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error relaying the embed request.';
    // Logged unconditionally (not behind the debug toggle, matching indexer.ts's own
    // embed-failure logging) so a real relay failure is visibly attributed to this code path
    // in the background console, distinct from the generic "Unchecked runtime.lastError"
    // line Chrome itself logs for a failed sendMessage independent of this catch.
    console.warn('[highlight-explainer] embed relay failed:', message);
    return { ok: false, error: message };
  }
}

export function registerEmbedListener(): void {
  // Chrome's runtime.onMessage ignores a Promise returned from a listener (that's a
  // Firefox/webextension-polyfill behaviour, and this project's `browser` global is just
  // `globalThis.chrome`). The documented Chrome pattern is to call sendResponse when the
  // async work finishes and synchronously return true so the channel stays open until then.
  browser.runtime.onMessage.addListener(
    (raw: unknown, _sender: unknown, sendResponse: (response?: EmbedResult) => void) => {
      if (!isContentEmbedRequest(raw)) return undefined;
      void handleEmbedRequest(raw.texts).then(sendResponse);
      return true; // keep the message channel open for the async sendResponse above
    },
  );
}
