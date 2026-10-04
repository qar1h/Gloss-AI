// BM25 keyword ranking over a conversation's chunks. Pure: no IndexedDB, no DOM. The index
// is rebuilt in memory from the chunk list on every search, so it can never be stale — an
// edited, regenerated or deleted message is correct automatically. The one expensive part,
// tokenising, can be skipped for unchanged chunks by passing a Bm25TermCache (keyed by the
// chunk's own content hash, so it needs no invalidation). See docs/benchmarks.

import { tokenize, tokenizeQuery } from './tokenize';
import type { Chunk } from './types';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** What tokenising one chunk produces. Treated as read-only once stored. */
export interface Bm25TermStats {
  termCounts: Map<string, number>;
  /** Number of tokens in the chunk (stopwords included — documents are not filtered). */
  length: number;
}

/** Chunk.textHash -> that chunk's term stats. Identical text means an identical entry. */
export type Bm25TermCache = Map<string, Bm25TermStats>;

export interface Bm25Doc extends Bm25TermStats {
  chunk: Chunk;
}

export interface Bm25Index {
  docs: Bm25Doc[];
  /** term -> how many chunks contain it at least once */
  documentFrequency: Map<string, number>;
  averageLength: number;
}

export interface Bm25Result {
  chunk: Chunk;
  score: number;
  /** The query terms this chunk actually contains, in query-term order. */
  matchedTerms: string[];
}

function computeTermStats(text: string): Bm25TermStats {
  const tokens = tokenize(text);
  const termCounts = new Map<string, number>();
  for (const token of tokens) termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
  return { termCounts, length: tokens.length };
}

/**
 * With a `cache`, chunks whose textHash is already in it skip tokenising, and afterwards the
 * cache holds exactly this chunk set's entries — anything no longer present is dropped, so
 * it can't grow without bound and never carries one conversation into another.
 */
export function buildBm25Index(chunks: Chunk[], cache?: Bm25TermCache): Bm25Index {
  const documentFrequency = new Map<string, number>();
  const used = new Set<string>();
  let totalLength = 0;

  const docs = chunks.map((chunk): Bm25Doc => {
    let stats = cache?.get(chunk.textHash);
    if (!stats) {
      stats = computeTermStats(chunk.text);
      cache?.set(chunk.textHash, stats);
    }
    used.add(chunk.textHash);
    for (const term of stats.termCounts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    totalLength += stats.length;
    return { chunk, termCounts: stats.termCounts, length: stats.length };
  });

  if (cache) {
    for (const key of cache.keys()) {
      if (!used.has(key)) cache.delete(key);
    }
  }

  return { docs, documentFrequency, averageLength: docs.length === 0 ? 0 : totalLength / docs.length };
}

/** Only chunks with a score above 0 are returned: chunks matching nothing aren't "ranked". */
export function scoreBm25(index: Bm25Index, queryTerms: string[], limit: number): Bm25Result[] {
  const { docs, documentFrequency, averageLength } = index;
  if (docs.length === 0 || queryTerms.length === 0 || averageLength === 0) return [];

  // Lucene-style IDF: unlike the textbook form it never goes negative for a term that
  // appears in more than half of the chunks, which is easy to hit in a small chat.
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const n = documentFrequency.get(term) ?? 0;
    idf.set(term, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)));
  }

  const results: Bm25Result[] = [];
  for (const doc of docs) {
    const lengthNorm = 1 - BM25_B + BM25_B * (doc.length / averageLength);
    let score = 0;
    const matchedTerms: string[] = [];
    for (const term of queryTerms) {
      const tf = doc.termCounts.get(term);
      if (!tf) continue;
      matchedTerms.push(term);
      score += idf.get(term)! * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lengthNorm));
    }
    if (score > 0) results.push({ chunk: doc.chunk, score, matchedTerms });
  }

  // Chunk.order, never Chunk.id: ids are strings, so "…:10:0" sorts before "…:2:0", and
  // IndexedDB hands chunks back in id order. Earlier chunk wins an exact tie.
  results.sort((a, b) => b.score - a.score || a.chunk.order - b.chunk.order);
  return results.slice(0, limit);
}

export function rankByBm25(
  chunks: Chunk[],
  queryText: string,
  limit: number,
  cache?: Bm25TermCache,
): Bm25Result[] {
  return scoreBm25(buildBm25Index(chunks, cache), tokenizeQuery(queryText), limit);
}
