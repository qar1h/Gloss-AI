import { describe, expect, it } from 'vitest';
import { cosineSimilarity, rankChunks } from './search';
import type { Chunk, EmbeddingRecord } from './types';

function makeChunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    conversationId: 'conv-1',
    messageId: '0',
    role: 'assistant',
    chunkIndex: 0,
    order: 0,
    text: 'chunk text',
    textHash: 'hash-a',
    wordCount: 2,
    hasCode: false,
    createdAt: 0,
    ...overrides,
  };
}

function makeEmbedding(chunkId: string, vector: number[], overrides: Partial<EmbeddingRecord> = {}): EmbeddingRecord {
  return {
    chunkId,
    conversationId: 'conv-1',
    vector,
    embeddingVersion: 1,
    chunkTextHash: 'hash-a',
    status: 'done',
    failureCount: 0,
    embeddedAt: 0,
    ...overrides,
  };
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('returns 0 instead of NaN for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('rankChunks', () => {
  it('ranks chunks by similarity to the query vector, highest first', () => {
    const chunks = [makeChunk('a'), makeChunk('b'), makeChunk('c')];
    const embeddings = [
      makeEmbedding('a', [1, 0]),
      makeEmbedding('b', [0, 1]),
      makeEmbedding('c', [0.9, 0.1]),
    ];
    const results = rankChunks(chunks, embeddings, [1, 0], 2);
    expect(results.map((r) => r.chunk.id)).toEqual(['a', 'c']);
  });

  it('skips chunks with a failed or missing embedding', () => {
    const chunks = [makeChunk('a'), makeChunk('b')];
    const embeddings = [makeEmbedding('a', [1, 0], { status: 'failed' })];
    const results = rankChunks(chunks, embeddings, [1, 0], 5);
    expect(results).toHaveLength(0);
  });

  it('respects k', () => {
    const chunks = [makeChunk('a'), makeChunk('b'), makeChunk('c')];
    const embeddings = [makeEmbedding('a', [1, 0]), makeEmbedding('b', [1, 0]), makeEmbedding('c', [1, 0])];
    expect(rankChunks(chunks, embeddings, [1, 0], 1)).toHaveLength(1);
  });
});
