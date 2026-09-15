// Runs inside the chrome.offscreen document — the only place transformers.js runs. This
// page has its own extension-origin storage, separate from the content script's
// page-origin IndexedDB, so it never touches storage directly: text in, vectors out.

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBEDDING_MODEL_ID } from '@/rag/embedder';
import type { EmbedResult, OffscreenEmbedRequest } from '@/messaging/types';

// transformers.js defaults onnxruntime-web's WASM loader to a jsDelivr CDN URL the moment
// it's imported (see its `ONNX_ENV.wasm.wasmPaths` block). An MV3 extension page can only
// load scripts from its own origin (`script-src 'self' 'wasm-unsafe-eval'`), so that default
// is blocked outright — the runtime never loads and every embed call fails. Point it at our
// own copies instead, shipped verbatim from `public/` (copied there from
// node_modules/onnxruntime-web/dist). This assignment is module scope, so it runs once when
// the offscreen document loads, long before getExtractor()'s first pipeline() call.
//
// numThreads is deliberately left alone: this page is not cross-origin isolated (no
// COOP/COEP), and onnxruntime-web already detects that itself — when numThreads is unset it
// checks `self.crossOriginIsolated` and pins the count to 1, so there's nothing to fix here.
const onnxWasm = env.backends.onnx.wasm;
if (onnxWasm) {
  onnxWasm.wasmPaths = {
    mjs: browser.runtime.getURL('/ort-wasm-simd-threaded.asyncify.mjs'),
    wasm: browser.runtime.getURL('/ort-wasm-simd-threaded.asyncify.wasm'),
  };
}

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    console.log('[highlight-explainer] downloading embedding model (first run)…');
    extractorPromise = pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

function isOffscreenEmbedRequest(message: unknown): message is OffscreenEmbedRequest {
  const m = message as Partial<OffscreenEmbedRequest>;
  return m.target === 'gloss-offscreen' && m.type === 'gloss-embed-request' && Array.isArray(m.texts);
}

async function embed(texts: string[]): Promise<EmbedResult> {
  try {
    const extractor = await getExtractor();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return { ok: true, vectors: output.tolist() as number[][] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown embedding error.';
    return { ok: false, error: message };
  }
}

// Chrome ignores a Promise returned from an onMessage listener — the sender would just get
// `undefined` back. The documented pattern is sendResponse + a synchronous `return true`,
// which keeps the message channel open until the async work below calls sendResponse.
browser.runtime.onMessage.addListener(
  (raw: unknown, _sender: unknown, sendResponse: (response?: EmbedResult) => void) => {
    if (!isOffscreenEmbedRequest(raw)) return undefined;
    void embed(raw.texts).then(sendResponse);
    return true; // keep the message channel open for the async sendResponse above
  },
);
