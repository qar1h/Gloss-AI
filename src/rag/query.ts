// Pure string logic for search-query construction and small-chunk embedding input. No
// DOM access — callers already have the paragraph/highlight text from the site adapter.

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;
const MIN_EMBED_WORDS = 12;
const MAX_EMBED_WORDS = 180; // matches the chunker's own ceiling (src/rag/chunker.ts)

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter((w) => w.length > 0);
}

/** The sentence(s) in `paragraph` that overlap `highlight`, or the whole paragraph if none match. */
export function extractSurroundingSentence(paragraph: string, highlight: string): string {
  const trimmedHighlight = highlight.trim();
  if (!trimmedHighlight || !paragraph.includes(trimmedHighlight)) return paragraph;

  const sentences = paragraph.split(SENTENCE_SPLIT).filter((s) => s.trim().length > 0);
  const matching = sentences.filter((s) => s.includes(trimmedHighlight) || trimmedHighlight.includes(s));
  return matching.length > 0 ? matching.join(' ') : paragraph;
}

/**
 * The text embedded at search time. `typedQuestion` is a plug-in point for a future
 * per-highlight question input in the popup — v3 has no such input, so every v3 caller
 * passes it as empty and this term is inert today.
 */
export function buildSearchQueryText(highlight: string, paragraph: string, typedQuestion = ''): string {
  const sentence = extractSurroundingSentence(paragraph, highlight);
  const parts = [highlight];
  if (sentence && sentence.trim() !== highlight.trim()) parts.push(sentence);
  if (typedQuestion.trim()) parts.push(typedQuestion.trim());
  return parts.join('\n');
}

/**
 * The text actually sent to the embedder for one chunk. Chunks at or above
 * MIN_EMBED_WORDS embed as themselves. Smaller chunks (a bare code line, a short
 * fragment) embed as themselves plus trimmed neighbor text, so the vector isn't built
 * from a string with no semantic content on its own. The stored Chunk.text is never
 * touched by this — it only affects what gets embedded.
 */
export function buildEmbedInputForChunk(
  chunkText: string,
  previousChunkText: string | null,
  nextChunkText: string | null,
): string {
  if (wordCount(chunkText) >= MIN_EMBED_WORDS) return chunkText;

  let budget = MAX_EMBED_WORDS - wordCount(chunkText);
  const parts: string[] = [];

  if (previousChunkText && budget > 0) {
    const previousWords = words(previousChunkText);
    const take = Math.min(Math.ceil(budget / 2), previousWords.length);
    parts.push(previousWords.slice(previousWords.length - take).join(' '));
    budget -= take;
  }

  parts.push(chunkText);

  if (nextChunkText && budget > 0) {
    const nextWords = words(nextChunkText);
    const take = Math.min(budget, nextWords.length);
    parts.push(nextWords.slice(0, take).join(' '));
  }

  return parts.join('\n');
}
