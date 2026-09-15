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

/** Pure ranking over already-fetched data — no IndexedDB here, so this is unit-testable. */
export function rankChunks(
  chunks: Chunk[],
  embeddings: EmbeddingRecord[],
  queryVector: number[],
  k: number,
): ScoredChunk[] {
  const vectorByChunkId = new Map(
    embeddings.filter((e) => e.status === 'done').map((e) => [e.chunkId, e.vector] as const),
  );

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
