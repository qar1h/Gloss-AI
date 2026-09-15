// Local embedding pipeline config. One constant for the model id, exactly so swapping
// models later (or a Hugging Face repo move) is a one-line change — same pattern as
// DEFAULT_MODEL_ID in src/llm/gemini.ts.
//
// This was `onnx-community/all-MiniLM-L6-v2-ONNX` (taken from the installed library's JSDoc
// examples), but those examples pass no dtype, and we do: `dtype: 'q8'` resolves to the file
// `onnx/model_quantized.onnx`, which that repo does not contain (its only weight files are
// model / model_fp16 / model_q4 / model_q4f16, each split across an extra .onnx_data file).
// Verified against the Hugging Face file-listing API, not guessed — loading it would have
// 404'd on the first real embed. `Xenova/all-MiniLM-L6-v2` is the long-standing
// transformers.js repo for the same model and does ship `onnx/model_quantized.onnx` (~23MB,
// one self-contained file), which is exactly the small quantized download the v3 plan's
// model decision assumed.
export const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

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
