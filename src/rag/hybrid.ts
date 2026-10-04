// Embedding ranking + BM25 ranking + reciprocal rank fusion, plus the rows the debug
// command prints. The ranking and row-building functions are pure over already-fetched
// data (same split as search.ts); only hybridSearch touches IndexedDB.

import { rankByBm25, type Bm25Result, type Bm25TermCache } from './bm25';
import { reciprocalRankFusion, RRF_DEPTH, type FusedChunk } from './fusion';
import { rankChunks, type ScoredChunk } from './search';
import { getAllChunks, getAllEmbeddings } from './store';
import { tokenizeQuery } from './tokenize';
import type { Chunk, EmbeddingRecord } from './types';

export interface HybridRanking {
  /** The terms BM25 actually searched for (empty = BM25 abstained). */
  queryTerms: string[];
  embeddingList: ScoredChunk[];
  bm25List: Bm25Result[];
  /** Every chunk in either capped list, best fused score first. */
  fused: FusedChunk[];
  matchedTermsByChunkId: Map<string, string[]>;
  chunkCount: number;
  /** Chunks that currently have a usable (status 'done') embedding. */
  embeddedCount: number;
  /** Whether a list had more candidates than `depth`, i.e. the cap actually cut something. */
  capBinding: { embedding: boolean; bm25: boolean };
}

export function hybridRank(
  chunks: Chunk[],
  embeddings: EmbeddingRecord[],
  queryVector: number[] | null,
  bm25QueryText: string,
  depth = RRF_DEPTH,
  termCache?: Bm25TermCache,
): HybridRanking {
  // IndexedDB returns chunks in string-id order ("…:10:0" before "…:2:0"), and rankChunks
  // breaks exact cosine ties by input order. Sorting by chat order first makes those ties
  // (e.g. a repeated paragraph) resolve the same way every time. rankChunks itself is v3 code
  // and is left as it is.
  const ordered = [...chunks].sort((a, b) => a.order - b.order);

  // Ask each ranker for one more than `depth`, purely to learn whether the cap binds.
  const embeddingProbe = queryVector ? rankChunks(ordered, embeddings, queryVector, depth + 1) : [];
  const bm25Probe = rankByBm25(ordered, bm25QueryText, depth + 1, termCache);
  const embeddingList = embeddingProbe.slice(0, depth);
  const bm25List = bm25Probe.slice(0, depth);

  const doneChunkIds = new Set(embeddings.filter((e) => e.status === 'done').map((e) => e.chunkId));

  return {
    queryTerms: tokenizeQuery(bm25QueryText),
    embeddingList,
    bm25List,
    fused: reciprocalRankFusion(embeddingList, bm25List, depth),
    matchedTermsByChunkId: new Map(bm25List.map((r) => [r.chunk.id, r.matchedTerms] as const)),
    chunkCount: chunks.length,
    embeddedCount: chunks.filter((c) => doneChunkIds.has(c.id)).length,
    capBinding: { embedding: embeddingProbe.length > depth, bm25: bm25Probe.length > depth },
  };
}

export interface DebugRow {
  fusedRank: number;
  chunk: string; // `${messageId}:${chunkIndex}`
  embedding: string; // "rank / cosine", or "–" if not in the embedding list
  bm25: string; // "rank / score", or "–" if not in the BM25 list
  from: 'both' | 'emb only' | 'bm25 only';
  ownMsg: 'yes' | '';
  matched: string;
  preview: string;
}

/**
 * The union of the top-k fused chunks and the top-k of each list, in fused order. Ranks come
 * from the full capped lists, so a row can show rank 17 even though k is 5.
 */
export function buildDebugRows(
  ranking: HybridRanking,
  k: number,
  ownMessageIds: ReadonlySet<string>,
): DebugRow[] {
  const rows: DebugRow[] = [];
  ranking.fused.forEach((f, index) => {
    const inTop = index < k || (f.embeddingRank !== null && f.embeddingRank <= k) || (f.bm25Rank !== null && f.bm25Rank <= k);
    if (!inTop) return;
    rows.push({
      fusedRank: index + 1,
      chunk: `${f.chunk.messageId}:${f.chunk.chunkIndex}`,
      embedding: f.embeddingRank === null ? '–' : `${f.embeddingRank} / ${f.embeddingScore!.toFixed(3)}`,
      bm25: f.bm25Rank === null ? '–' : `${f.bm25Rank} / ${f.bm25Score!.toFixed(2)}`,
      from: f.embeddingRank !== null && f.bm25Rank !== null ? 'both' : f.embeddingRank !== null ? 'emb only' : 'bm25 only',
      ownMsg: ownMessageIds.has(f.chunk.messageId) ? 'yes' : '',
      matched: (ranking.matchedTermsByChunkId.get(f.chunk.id) ?? []).join(', '),
      preview: f.chunk.text.slice(0, 80),
    });
  });
  return rows;
}

/** One line saying how big the lists were and whether the depth cap cut anything. */
export function describeLists(ranking: HybridRanking, depth: number): string {
  const binding = [
    ranking.capBinding.embedding ? 'embedding' : null,
    ranking.capBinding.bm25 ? 'bm25' : null,
  ].filter((name): name is string => name !== null);
  const cap = binding.length === 0 ? 'cap not binding' : `cap binding on: ${binding.join(', ')}`;
  return (
    `chunks: ${ranking.chunkCount} (${ranking.embeddedCount} embedded) | ` +
    `lists: embedding ${ranking.embeddingList.length}, bm25 ${ranking.bm25List.length} | depth ${depth} — ${cap}`
  );
}

// Tokenising is the one expensive part of BM25 (see docs/benchmarks), so the term counts of
// each chunk are kept between searches, keyed by the chunk's own content hash. The key
// changes whenever the text does, so an edited message is re-tokenised and nothing goes
// stale. buildBm25Index prunes entries for chunks that are gone, which also drops the old
// conversation's entries when you switch chats. Lives only in memory; nothing is persisted.
const termCache: Bm25TermCache = new Map();

/** Reads a conversation's chunks + embeddings from IndexedDB once and ranks them. */
export async function hybridSearch(
  conversationId: string,
  queryVector: number[] | null,
  bm25QueryText: string,
  depth = RRF_DEPTH,
): Promise<HybridRanking> {
  const [chunks, embeddings] = await Promise.all([getAllChunks(conversationId), getAllEmbeddings(conversationId)]);
  return hybridRank(chunks, embeddings, queryVector, bm25QueryText, depth, termCache);
}
