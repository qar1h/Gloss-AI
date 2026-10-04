// Runs inside the chrome.offscreen document — the only place transformers.js runs. This
// page has its own extension-origin storage, separate from the content script's
// page-origin IndexedDB, so it never touches storage directly: text in, vectors out.

import { EMBEDDING_MODEL_ID } from '@/rag/embedder';
import type { EmbedResult, OffscreenEmbedRequest, OffscreenReadyAnnouncement } from '@/messaging/types';

// @huggingface/transformers is loaded dynamically (not a static top-level import) so that a
// failure inside IT (an environment-detection assumption the library makes that doesn't hold
// in an offscreen document, say) can't prevent this file's own listener from registering and
// announcing readiness below. A crash here still surfaces — it just surfaces as a real embed
// request failing with a specific error, not as "the document silently never existed." This
// type-only import is erased at compile time — it causes no runtime import of its own.
type FeatureExtractionPipeline = import('@huggingface/transformers').FeatureExtractionPipeline;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let wasmPathsConfigured = false;

async function loadExtractor(): Promise<FeatureExtractionPipeline> {
  const { env, pipeline } = await import('@huggingface/transformers');

  // transformers.js defaults onnxruntime-web's WASM loader to a jsDelivr CDN URL the moment
  // it's imported (see its `ONNX_ENV.wasm.wasmPaths` block). An MV3 extension page can only
  // load scripts from its own origin (`script-src 'self' 'wasm-unsafe-eval'`), so that
  // default is blocked outright. Point it at our own copies instead, shipped verbatim from
  // `public/` (copied there from node_modules/onnxruntime-web/dist). This has to happen once
  // per module load, right after the import resolves and before the first pipeline() call —
  // it's guarded so a second embed request doesn't redo it.
  //
  // numThreads is deliberately left alone: this page is not cross-origin isolated (no
  // COOP/COEP), and onnxruntime-web already detects that itself — when numThreads is unset
  // it checks `self.crossOriginIsolated` and pins the count to 1, so there's nothing to fix.
  if (!wasmPathsConfigured) {
    const onnxWasm = env.backends.onnx.wasm;
    if (onnxWasm) {
      onnxWasm.wasmPaths = {
        mjs: browser.runtime.getURL('/ort-wasm-simd-threaded.asyncify.mjs'),
        wasm: browser.runtime.getURL('/ort-wasm-simd-threaded.asyncify.wasm'),
      };
    }
    wasmPathsConfigured = true;
  }

  return pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>;
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    console.log('[highlight-explainer] downloading embedding model (first run)…');
    extractorPromise = loadExtractor().catch((error: unknown) => {
      // A failed load (e.g. a dropped connection mid-download) would otherwise be cached
      // forever — every later embed call would just re-await this same rejected promise.
      // Clear it so the next call starts a fresh download attempt instead of being stuck.
      extractorPromise = null;
      throw error;
    });
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

// Announce readiness the instant the listener above is registered — before the dynamic
// import of transformers.js even starts. If background/handleEmbed.ts's wait for this times
// out, the problem is in this file's own bare setup (manifest/CSP/bundling), not in the
// model library. No one may be listening yet if this fires before handleEmbed.ts starts
// waiting — that race is closed on the background side by registering its listener before
// calling createDocument(), not by retrying here.
const ready: OffscreenReadyAnnouncement = { target: 'gloss-offscreen-ready' };
void browser.runtime.sendMessage(ready).catch(() => {
  // No one was listening for this broadcast — harmless (e.g. a second, already-alive
  // document being queried some other way in the future).
});
