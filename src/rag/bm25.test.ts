import { describe, expect, it } from 'vitest';
import { buildBm25Index, rankByBm25, scoreBm25 } from './bm25';
import type { Chunk } from './types';

function makeChunk(id: string, text: string, order = 0): Chunk {
  return {
    id,
    conversationId: 'conv-1',
    messageId: '0',
    role: 'assistant',
    chunkIndex: 0,
    order,
    text,
    textHash: `hash-${id}`,
    wordCount: text.split(/\s+/).length,
    hasCode: false,
    createdAt: 0,
  };
}

describe('buildBm25Index', () => {
  it('counts how many chunks contain each term, and the average chunk length', () => {
    const index = buildBm25Index([makeChunk('a', 'alpha beta'), makeChunk('b', 'alpha')]);
    expect(index.documentFrequency.get('alpha')).toBe(2);
    expect(index.documentFrequency.get('beta')).toBe(1);
    expect(index.averageLength).toBe(1.5);
  });

  it('has an average length of 0 for no chunks', () => {
    expect(buildBm25Index([]).averageLength).toBe(0);
  });
});

describe('rankByBm25', () => {
  it('ranks a chunk with the rare query term above chunks with only the common one', () => {
    const chunks = [
      makeChunk('a', 'the cache layer uses redis', 1),
      makeChunk('b', 'the cache layer uses memcached', 2),
      makeChunk('c', 'the cache layer is fast', 3),
      makeChunk('d', 'the cache layer is slow', 4),
    ];
    const results = rankByBm25(chunks, 'redis cache', 10);
    expect(results[0]!.chunk.id).toBe('a');
    expect(results).toHaveLength(4);
  });

  it('never produces a negative or NaN score, even for a term in every chunk', () => {
    const chunks = [makeChunk('a', 'alpha one'), makeChunk('b', 'alpha two'), makeChunk('c', 'alpha three')];
    const results = rankByBm25(chunks, 'alpha', 10);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it('prefers a short chunk over a long one with the same single occurrence', () => {
    const filler = Array.from({ length: 199 }, (_, i) => `filler${i}`).join(' ');
    const chunks = [
      makeChunk('long', `alpha ${filler}`, 1),
      makeChunk('short', 'alpha beta gamma delta epsilon', 2),
    ];
    const results = rankByBm25(chunks, 'alpha', 10);
    expect(results.map((r) => r.chunk.id)).toEqual(['short', 'long']);
  });

  it('saturates term frequency: ten occurrences beat one, but by far less than ten times', () => {
    const chunks = [
      makeChunk('many', 'alpha '.repeat(10) + 'filler '.repeat(10), 1),
      makeChunk('one', 'alpha ' + 'filler '.repeat(19), 2),
      makeChunk('none', 'other '.repeat(20), 3),
    ];
    const results = rankByBm25(chunks, 'alpha', 10);
    const many = results.find((r) => r.chunk.id === 'many')!.score;
    const one = results.find((r) => r.chunk.id === 'one')!.score;
    expect(many).toBeGreaterThan(one);
    expect(many / one).toBeLessThan(10);
  });

  it('leaves out chunks that match no query term', () => {
    const chunks = [makeChunk('a', 'alpha'), makeChunk('b', 'beta'), makeChunk('c', 'alpha gamma')];
    const results = rankByBm25(chunks, 'alpha', 10);
    expect(results.map((r) => r.chunk.id).sort()).toEqual(['a', 'c']);
  });

  it('respects the limit', () => {
    const chunks = [makeChunk('a', 'alpha', 1), makeChunk('b', 'alpha', 2), makeChunk('c', 'alpha', 3)];
    expect(rankByBm25(chunks, 'alpha', 2)).toHaveLength(2);
  });

  it('abstains for an empty, all-stopword or punctuation-only query', () => {
    const chunks = [makeChunk('a', 'it is the case that alpha holds')];
    expect(rankByBm25(chunks, '', 10)).toEqual([]);
    expect(rankByBm25(chunks, 'it is', 10)).toEqual([]);
    expect(rankByBm25(chunks, '!!', 10)).toEqual([]);
  });

  it('returns nothing for no chunks, or for chunks with no tokens', () => {
    expect(rankByBm25([], 'alpha', 10)).toEqual([]);
    expect(rankByBm25([makeChunk('a', ''), makeChunk('b', '   ')], 'alpha', 10)).toEqual([]);
  });

  it('ranks an exact identifier above a chunk that only shares one part of it', () => {
    const chunks = [
      makeChunk('code', 'engine = create_engine(url, pool_pre_ping=True)', 1),
      makeChunk('prose', 'the connection pool is shared between threads', 2),
      makeChunk('other', 'something entirely unrelated here', 3),
    ];
    const results = rankByBm25(chunks, 'pool_pre_ping', 10);
    expect(results.map((r) => r.chunk.id)).toEqual(['code', 'prose']);
    expect(results[1]!.matchedTerms).toEqual(['pool']);
  });

  it('finds prose that spells an identifier with hyphens or spaces', () => {
    const chunks = [
      makeChunk('prose', 'we pre-ping the connection before use', 1),
      makeChunk('other', 'something entirely unrelated here', 2),
    ];
    const results = rankByBm25(chunks, 'pool_pre_ping', 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.matchedTerms).toEqual(['pre', 'ping']);
  });

  it('reports only the query terms found in each chunk, in query-term order', () => {
    const chunks = [makeChunk('a', 'gamma beta alpha'), makeChunk('b', 'delta')];
    const results = rankByBm25(chunks, 'alpha beta zeta', 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.matchedTerms).toEqual(['alpha', 'beta']);
  });

  it('breaks exact ties by chunk order, whatever order the chunks were passed in', () => {
    const chunks = [
      makeChunk('x', 'same text', 30),
      makeChunk('y', 'same text', 10),
      makeChunk('z', 'same text', 20),
    ];
    const results = rankByBm25(chunks, 'text', 10);
    expect(results.map((r) => r.chunk.order)).toEqual([10, 20, 30]);
  });

  it('breaks ties by order, not by id (ids sort as strings: "…:10:0" before "…:2:0")', () => {
    const chunks = [makeChunk('c:10:0', 'same text', 10000), makeChunk('c:2:0', 'same text', 2000)];
    const results = rankByBm25(chunks, 'text', 10);
    expect(results.map((r) => r.chunk.id)).toEqual(['c:2:0', 'c:10:0']);
  });

  it('does not match a query containing the start of a giant blob that was left out of the index', () => {
    const blob = 'A1b2'.repeat(12);
    const chunks = [makeChunk('a', `token ${blob} end`)];
    expect(rankByBm25(chunks, 'A1b2A1b2', 10)).toEqual([]);
  });
});

describe('buildBm25Index with a term-count cache', () => {
  const chunks = () => [
    makeChunk('a', 'alpha beta alpha', 1),
    makeChunk('b', 'beta gamma', 2),
    makeChunk('c', 'delta', 3),
  ];

  it('produces exactly the same ranking as building without a cache', () => {
    const cache = new Map();
    const withCache = scoreBm25(buildBm25Index(chunks(), cache), ['alpha', 'beta'], 10);
    const without = scoreBm25(buildBm25Index(chunks()), ['alpha', 'beta'], 10);
    expect(withCache.map((r) => [r.chunk.id, r.score])).toEqual(without.map((r) => [r.chunk.id, r.score]));
  });

  it('still gives the same ranking when the second build is served from the cache', () => {
    const cache = new Map();
    const first = scoreBm25(buildBm25Index(chunks(), cache), ['alpha', 'beta'], 10);
    const second = scoreBm25(buildBm25Index(chunks(), cache), ['alpha', 'beta'], 10);
    expect(second.map((r) => [r.chunk.id, r.score])).toEqual(first.map((r) => [r.chunk.id, r.score]));
  });

  it('keeps one entry per distinct textHash, so identical chunks share one', () => {
    const cache = new Map();
    const twins = [
      makeChunk('x', 'same words', 1),
      makeChunk('y', 'same words', 2),
    ];
    twins[1]!.textHash = twins[0]!.textHash;
    buildBm25Index(twins, cache);
    expect(cache.size).toBe(1);
  });

  it('reuses the stored term counts of an unchanged chunk and recomputes a changed one', () => {
    const cache = new Map();
    buildBm25Index(chunks(), cache);
    const before = new Map(cache);

    const next = chunks();
    next[1] = { ...next[1]!, text: 'beta gamma epsilon', textHash: 'hash-b-edited' };
    const index = buildBm25Index(next, cache);

    expect(cache.get('hash-a')).toBe(before.get('hash-a')); // untouched chunk: same stored object
    expect(cache.get('hash-b-edited')).toBeDefined();
    expect(index.documentFrequency.get('epsilon')).toBe(1); // the edit is visible to the statistics
  });

  it('drops entries for chunks that no longer exist, so the cache cannot grow without bound', () => {
    const cache = new Map();
    buildBm25Index(chunks(), cache);
    expect(cache.size).toBe(3);
    buildBm25Index([makeChunk('a', 'alpha beta alpha', 1)], cache);
    expect([...cache.keys()]).toEqual(['hash-a']);
  });

  it('does not let a cached chunk leak into a different conversation’s statistics', () => {
    const cache = new Map();
    buildBm25Index(chunks(), cache);
    const other = buildBm25Index([makeChunk('z', 'zeta', 1)], cache);
    expect(other.docs).toHaveLength(1);
    expect(other.documentFrequency.has('alpha')).toBe(false);
    expect(other.averageLength).toBe(1);
  });
});

describe('scoreBm25', () => {
  it('scores against a prebuilt index, so the index can be built once and reused', () => {
    const index = buildBm25Index([makeChunk('a', 'alpha beta'), makeChunk('b', 'gamma')]);
    expect(scoreBm25(index, ['alpha'], 10).map((r) => r.chunk.id)).toEqual(['a']);
    expect(scoreBm25(index, ['gamma'], 10).map((r) => r.chunk.id)).toEqual(['b']);
  });
});
