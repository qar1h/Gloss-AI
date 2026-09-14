// Local embedding pipeline config. One constant for the model id, exactly so swapping
// models later (or a Hugging Face repo move) is a one-line change — same pattern as
// DEFAULT_MODEL_ID in src/llm/gemini.ts. Verify this repo id and the 'q8' dtype (used in
// Task 4, where the model is actually loaded) are both still valid for the installed
// @huggingface/transformers version before relying on this — Hugging Face repo names and
// quantization option names have moved before, same caution CLAUDE.md already gives for
// Gemini model ids.
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
