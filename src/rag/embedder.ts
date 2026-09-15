// Local embedding pipeline config. One constant for the model id, exactly so swapping
// models later (or a Hugging Face repo move) is a one-line change — same pattern as
// DEFAULT_MODEL_ID in src/llm/gemini.ts. This model id was verified against the installed
// @huggingface/transformers package's own documentation (types/pipelines/feature-extraction.d.ts
// and JSDoc examples), which demonstrates the onnx-community namespace, not Xenova.
// The 'q8' dtype (used in Task 4, where the model is actually loaded) is also verified
// as a valid option for this model in the installed version.
export const EMBEDDING_MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';

// Bump this whenever the model or how it's called changes, so the indexer force-re-embeds
// every chunk even when its content hasn't changed — same pattern as CHUNKER_VERSION.
export const EMBEDDING_VERSION = 1;

import type { EmbedRequest, EmbedResult } from '@/messaging/types';

/** Runs in the content script: asks the background worker (which relays to the offscreen
 * document, wired up in Task 4) to embed a batch of texts. Never called with an empty array. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const request: EmbedRequest = { type: 'gloss-embed-request', texts };
  const result = (await browser.runtime.sendMessage(request)) as EmbedResult;
  if (!result.ok) throw new Error(result.error);
  return result.vectors;
}
