// The numbers that shape prompt assembly. The user-editable ones are stored as settings
// (src/options/storage.ts) and clamped here, so a bad value can never silently turn the
// budget into 0. Pure — no DOM, no storage.

export const DEFAULT_BUDGET_TOKENS = 6000;
/** Equal to the budget by default, so there is no cliff where a slightly bigger chat suddenly gets a much smaller prompt. */
export const DEFAULT_THRESHOLD_TOKENS = 6000;
/** Default cap on excerpts; this is the existing `retrievalK` setting. */
export const DEFAULT_MAX_CHUNKS = 8;
export const DEFAULT_RECENT_COUNT = 2;
export const MAX_RECENT_COUNT = 6;

/** One pasted file must not eat the prompt: past these, the item is trimmed with a visible marker. */
export const SOURCE_MESSAGE_CEILING_TOKENS = 4000;
export const QUESTION_CEILING_TOKENS = 4000;

/**
 * The "paragraph" of a code highlight is the whole code block, which the source message
 * already contains, so it is windowed around the highlight rather than sent twice in full.
 * The highlight itself is never trimmed.
 */
export const PARAGRAPH_CEILING_TOKENS = 400;

/**
 * A recent message is only worth always sending when it is small enough to be cheap context
 * for a follow-up ("the second option"). One bigger than this is not trimmed (head and tail of
 * a big message are usually the least useful parts); it is *demoted*: left out of the
 * always-include part and not excluded from retrieval, so only its relevant chunks come back.
 * Found in the v5 live test: a ≈1670-token models.py was 53% of an unrelated prompt.
 */
export const RECENT_ALWAYS_MAX_TOKENS = 1000;

/** Covers the cold start (offscreen document + model load) without hanging the popup forever. */
export const EMBED_QUERY_TIMEOUT_MS = 8000;

export interface AssemblyOptions {
  budgetTokens: number;
  thresholdTokens: number;
  maxChunks: number;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveAssemblyOptions(raw: {
  budgetTokens?: unknown;
  thresholdTokens?: unknown;
  maxChunks?: unknown;
}): AssemblyOptions {
  return {
    budgetTokens: positiveInt(raw.budgetTokens, DEFAULT_BUDGET_TOKENS),
    thresholdTokens: positiveInt(raw.thresholdTokens, DEFAULT_THRESHOLD_TOKENS),
    maxChunks: positiveInt(raw.maxChunks, DEFAULT_MAX_CHUNKS),
  };
}

/** 0 is allowed (no recent messages); the question is always included regardless. */
export function resolveRecentCount(value: unknown): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RECENT_COUNT;
  return Math.min(n, MAX_RECENT_COUNT);
}
