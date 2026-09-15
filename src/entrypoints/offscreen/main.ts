// Runs inside the chrome.offscreen document — the only place transformers.js runs. This
// page has its own extension-origin storage, separate from the content script's
// page-origin IndexedDB, so it never touches storage directly: text in, vectors out.

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { EMBEDDING_MODEL_ID } from '@/rag/embedder';
import type { EmbedResult, OffscreenEmbedRequest } from '@/messaging/types';

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

browser.runtime.onMessage.addListener((raw: unknown) => {
  if (!isOffscreenEmbedRequest(raw)) return undefined;

  return (async (): Promise<EmbedResult> => {
    try {
      const extractor = await getExtractor();
      const output = await extractor(raw.texts, { pooling: 'mean', normalize: true });
      return { ok: true, vectors: output.tolist() as number[][] };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown embedding error.';
      return { ok: false, error: message };
    }
  })();
});
