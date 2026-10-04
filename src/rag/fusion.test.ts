import { describe, expect, it } from 'vitest';
import { RRF_DEPTH, RRF_K, reciprocalRankFusion, type RankedItem } from './fusion';
import type { Chunk } from './types';

function makeChunk(id: string, order = 0): Chunk {
  return {
    id,
    conversationId: 'conv-1',
    messageId: '0',
    role: 'assistant',
    chunkIndex: 0,
    order,
    text: id,
    textHash: `hash-${id}`,
    wordCount: 1,
    hasCode: false,
    createdAt: 0,
  };
}

/** A best-first list; each item's score is just 100 - position, so it's easy to recognise. */
function list(...chunks: Chunk[]): RankedItem[] {
  return chunks.map((chunk, i) => ({ chunk, score: 100 - i }));
}

const ids = (fused: { chunk: Chunk }[]) => fused.map((f) => f.chunk.id);

describe('reciprocalRankFusion', () => {
  it('uses the constant 60 with 1-based ranks: rank 1 in one list scores exactly 1/61', () => {
    expect(RRF_K).toBe(60);
    const fused = reciprocalRankFusion(list(makeChunk('a')), []);
    expect(fused[0]!.score).toBe(1 / 61);
  });

  it('ranks a chunk that is #2 in both lists above one that is #1 in a single list', () => {
    const a = makeChunk('a');
    const b = makeChunk('b');
    const c = makeChunk('c');
    const fused = reciprocalRankFusion(list(a, b), list(c, b));
    expect(ids(fused)[0]).toBe('b');
    expect(fused[0]!.score).toBeCloseTo(2 / 62, 12);
    expect(fused[0]!.score).toBeGreaterThan(1 / 61);
  });

  it('gives a chunk found by only one list just that list’s term, and null for the other', () => {
    const a = makeChunk('a');
    const b = makeChunk('b');
    const fused = reciprocalRankFusion(list(a), list(b));
    const fa = fused.find((f) => f.chunk.id === 'a')!;
    const fb = fused.find((f) => f.chunk.id === 'b')!;
    expect(fa.embeddingRank).toBe(1);
    expect(fa.bm25Rank).toBeNull();
    expect(fa.bm25Score).toBeNull();
    expect(fa.score).toBe(1 / 61);
    expect(fb.embeddingRank).toBeNull();
    expect(fb.embeddingScore).toBeNull();
    expect(fb.bm25Rank).toBe(1);
    expect(fb.score).toBe(1 / 61);
  });

  it('carries each list’s rank and original score through', () => {
    const a = makeChunk('a');
    const b = makeChunk('b');
    const fused = reciprocalRankFusion(
      [{ chunk: a, score: 0.9 }, { chunk: b, score: 0.4 }],
      [{ chunk: b, score: 7.5 }],
    );
    const fb = fused.find((f) => f.chunk.id === 'b')!;
    expect(fb.embeddingRank).toBe(2);
    expect(fb.embeddingScore).toBe(0.4);
    expect(fb.bm25Rank).toBe(1);
    expect(fb.bm25Score).toBe(7.5);
  });

  it('cuts each list to the depth: with depth 2, rank 3 is treated as absent', () => {
    const [a, b, c] = [makeChunk('a'), makeChunk('b'), makeChunk('c')];
    const fused = reciprocalRankFusion(list(a, b, c), [], 2);
    expect(ids(fused)).toEqual(['a', 'b']);
  });

  it('defaults to a depth of 50: rank 50 is kept, rank 51 is dropped', () => {
    expect(RRF_DEPTH).toBe(50);
    const many = Array.from({ length: 60 }, (_, i) => makeChunk(`c${i}`, i));
    const fused = reciprocalRankFusion(list(...many), []);
    expect(fused).toHaveLength(50);
    expect(ids(fused)).toContain('c49');
    expect(ids(fused)).not.toContain('c50');
  });

  it('breaks an exact tie by chunk order, earlier first', () => {
    const e1 = makeChunk('e1', 1);
    const e2 = makeChunk('e2', 2);
    const late = makeChunk('late', 50); // emb-only, rank 3
    const b1 = makeChunk('b1', 3);
    const b2 = makeChunk('b2', 4);
    const early = makeChunk('early', 10); // bm25-only, rank 3 -> same score as `late`
    const fused = reciprocalRankFusion(list(e1, e2, late), list(b1, b2, early));
    expect(ids(fused).indexOf('early')).toBeLessThan(ids(fused).indexOf('late'));
  });

  it('breaks the tie between two mirrored two-list chunks by chunk order', () => {
    // x is emb #2 / bm25 #4, y is emb #4 / bm25 #2 -> identical fused score.
    const x = makeChunk('x', 20);
    const y = makeChunk('y', 10);
    const f = [1, 2, 3, 4, 5, 6].map((n) => makeChunk(`f${n}`, 100 + n));
    const fused = reciprocalRankFusion(list(f[0]!, x, f[1]!, y), list(f[2]!, y, f[3]!, x));
    const fx = fused.find((r) => r.chunk.id === 'x')!;
    const fy = fused.find((r) => r.chunk.id === 'y')!;
    expect(fx.score).toBe(fy.score);
    expect(ids(fused).indexOf('y')).toBeLessThan(ids(fused).indexOf('x'));
  });

  it('breaks ties by order, not by id (ids sort as strings: "…:10:0" before "…:2:0")', () => {
    const late = makeChunk('c:10:0', 10000);
    const early = makeChunk('c:2:0', 2000);
    const fused = reciprocalRankFusion(list(late), list(early));
    expect(ids(fused)).toEqual(['c:2:0', 'c:10:0']);
  });

  it('gives the same result when run twice', () => {
    const [a, b, c] = [makeChunk('a', 1), makeChunk('b', 2), makeChunk('c', 3)];
    const first = reciprocalRankFusion(list(a, b, c), list(c, a));
    const second = reciprocalRankFusion(list(a, b, c), list(c, a));
    expect(ids(first)).toEqual(ids(second));
  });

  it('handles empty lists on either side or both', () => {
    const [a, b] = [makeChunk('a'), makeChunk('b')];
    expect(reciprocalRankFusion([], [])).toEqual([]);
    expect(ids(reciprocalRankFusion(list(a, b), []))).toEqual(['a', 'b']);
    expect(ids(reciprocalRankFusion([], list(b, a)))).toEqual(['b', 'a']);
  });

  it('does not mutate its inputs', () => {
    const [a, b] = [makeChunk('a'), makeChunk('b')];
    const emb = Object.freeze(list(a, b).map((item) => Object.freeze(item))) as RankedItem[];
    const bm = Object.freeze(list(b, a).map((item) => Object.freeze(item))) as RankedItem[];
    expect(() => reciprocalRankFusion(emb, bm)).not.toThrow();
    expect(ids(emb)).toEqual(['a', 'b']);
    expect(ids(bm)).toEqual(['b', 'a']);
  });
});
