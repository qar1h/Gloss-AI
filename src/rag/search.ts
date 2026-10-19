import { getAllChunks, getAllEmbeddings } from './store';
import type { Chunk, EmbeddingRecord } from './types';

/** Both vectors are assumed to be the same length (they always come from the same
 * embedding model). Indexing with `!` is safe here because the loop never exceeds a.length. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/**
 * The vectors that really describe their chunk: status 'done' AND computed for the text the chunk
 * holds now. A chunk id is `<chat>:<position>:<index>`, so after a re-index, an edit, or a wipe
 * the same id can belong to different text; its old vector would then match the chunk on words it
 * no longer contains, and nothing would say so.
 */
export function usableVectors(chunks: Chunk[], embeddings: EmbeddingRecord[]): Map<string, number[]> {
  const textHashById = new Map(chunks.map((c) => [c.id, c.textHash] as const));
  const usable = new Map<string, number[]>();
  for (const e of embeddings) {
    if (e.status === 'done' && textHashById.get(e.chunkId) === e.chunkTextHash) usable.set(e.chunkId, e.vector);
  }
  return usable;
}

/** Pure ranking over already-fetched data — no IndexedDB here, so this is unit-testable. */
export function rankChunks(
  chunks: Chunk[],
  embeddings: EmbeddingRecord[],
  queryVector: number[],
  k: number,
): ScoredChunk[] {
  const vectorByChunkId = usableVectors(chunks, embeddings);

  const scored: ScoredChunk[] = [];
  for (const chunk of chunks) {
    const vector = vectorByChunkId.get(chunk.id);
    if (!vector) continue;
    scored.push({ chunk, score: cosineSimilarity(queryVector, vector) });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Reads a conversation's chunks + embeddings from IndexedDB and ranks them. */
export async function searchChunks(conversationId: string, queryVector: number[], k: number): Promise<ScoredChunk[]> {
  const [chunks, embeddings] = await Promise.all([getAllChunks(conversationId), getAllEmbeddings(conversationId)]);
  return rankChunks(chunks, embeddings, queryVector, k);
}
