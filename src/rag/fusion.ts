// Reciprocal rank fusion: merge two best-first rankings into one. Pure — no IndexedDB, no DOM.
// A chunk's fused score is the sum over the lists it appears in of 1 / (RRF_K + rank), with
// rank starting at 1. Only ranks matter, never the raw scores, which is why a cosine
// similarity (~0.4) and a BM25 score (~9.8) can be merged at all.

import type { Chunk } from './types';

export const RRF_K = 60;

/**
 * How many entries of each ranked list take part in fusion. A chat with fewer embedded
 * chunks than this is unaffected: the embedding list already holds every chunk, so the
 * cap only starts to bite on longer chats. Change it here, or pass `depth` per call.
 */
export const RRF_DEPTH = 50;

/** Structurally satisfied by search.ts's ScoredChunk and bm25.ts's Bm25Result. */
export interface RankedItem {
  chunk: Chunk;
  score: number;
}

export interface FusedChunk {
  chunk: Chunk;
  score: number;
  embeddingRank: number | null;
  embeddingScore: number | null;
  bm25Rank: number | null;
  bm25Score: number | null;
}

/**
 * Inputs must already be sorted best-first (rank = position + 1). Each is cut to its first
 * `depth` entries. Returns every fused chunk, best first — callers slice to their own k.
 * Equal fused scores are broken by chunk order (earlier chunk first), never by id.
 */
export function reciprocalRankFusion(
  embeddingList: RankedItem[],
  bm25List: RankedItem[],
  depth = RRF_DEPTH,
): FusedChunk[] {
  const byId = new Map<string, FusedChunk>();
  const entryFor = (chunk: Chunk): FusedChunk => {
    let entry = byId.get(chunk.id);
    if (!entry) {
      entry = { chunk, score: 0, embeddingRank: null, embeddingScore: null, bm25Rank: null, bm25Score: null };
      byId.set(chunk.id, entry);
    }
    return entry;
  };

  embeddingList.slice(0, depth).forEach((item, index) => {
    const entry = entryFor(item.chunk);
    entry.embeddingRank = index + 1;
    entry.embeddingScore = item.score;
    entry.score += 1 / (RRF_K + index + 1);
  });

  bm25List.slice(0, depth).forEach((item, index) => {
    const entry = entryFor(item.chunk);
    entry.bm25Rank = index + 1;
    entry.bm25Score = item.score;
    entry.score += 1 / (RRF_K + index + 1);
  });

  return [...byId.values()].sort((a, b) => b.score - a.score || a.chunk.order - b.chunk.order);
}
