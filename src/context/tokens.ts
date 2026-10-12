// Token estimation and trimming. CLAUDE.md's rule is characters / 4: close for English
// prose, an undercount for code (more tokens per character) and a bigger one for
// non-Latin scripts. At a 6000 budget that only shifts real usage, it never breaks a limit;
// every number printed from it is labelled "est.". Pure — no DOM.

export const CHARS_PER_TOKEN = 4;
export const TRIM_MARKER = '[… trimmed …]';

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface Trimmed {
  text: string;
  trimmed: boolean;
}

/** Keeps the start and the end of `text` and drops the middle, so the result fits `maxTokens`. */
export function trimMiddle(text: string, maxTokens: number): Trimmed {
  if (estimateTokens(text) <= maxTokens) return { text, trimmed: false };
  const keep = Math.max(0, maxTokens * CHARS_PER_TOKEN - TRIM_MARKER.length - 2);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  const tailText = tail > 0 ? text.slice(text.length - tail) : '';
  return { text: `${text.slice(0, head)}\n${TRIM_MARKER}\n${tailText}`, trimmed: true };
}

/**
 * Keeps a window of `text` centred on `anchor` (e.g. the highlighted paragraph inside a very
 * long message), with a marker on each side that was cut. If the anchor isn't in the text,
 * falls back to trimMiddle.
 */
export function windowAround(text: string, anchor: string, maxTokens: number): Trimmed {
  if (estimateTokens(text) <= maxTokens) return { text, trimmed: false };
  const found = anchor ? text.indexOf(anchor) : -1;
  if (found === -1) return trimMiddle(text, maxTokens);

  const budget = Math.max(0, maxTokens * CHARS_PER_TOKEN - 2 * (TRIM_MARKER.length + 1));
  const center = found + Math.floor(anchor.length / 2);
  const start = Math.max(0, Math.min(center - Math.floor(budget / 2), text.length - budget));
  const end = Math.min(text.length, start + budget);
  const body = text.slice(start, end);
  const lead = start > 0 ? `${TRIM_MARKER}\n` : '';
  const trail = end < text.length ? `\n${TRIM_MARKER}` : '';
  return { text: `${lead}${body}${trail}`, trimmed: true };
}
