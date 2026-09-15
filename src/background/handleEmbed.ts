// Relays embed requests from the content script to the offscreen document, creating that
// document lazily on first use and leaving it open afterward (reloading the model on every
// batch would be far slower than just keeping the document alive).

import type { EmbedRequest, EmbedResult, OffscreenEmbedRequest } from '@/messaging/types';

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';

let creatingOffscreenDocument: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS], // verify against current Chrome docs — see note below
      justification: 'Runs a local ONNX embedding model (transformers.js) to compute chunk vectors.',
    });
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
    const message = error instanceof Error ? error.message : 'Unknown error creating the offscreen embedding document.';
    return { ok: false, error: message };
  }
}

export function registerEmbedListener(): void {
  browser.runtime.onMessage.addListener((raw: unknown) => {
    if (!isContentEmbedRequest(raw)) return undefined;
    return handleEmbedRequest(raw.texts);
  });
}
