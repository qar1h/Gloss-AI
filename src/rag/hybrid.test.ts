import { describe, expect, it } from 'vitest';
import { buildDebugRows, describeLists, excludeMessages, hybridRank } from './hybrid';
import type { Chunk, EmbeddingRecord } from './types';

function makeChunk(id: string, text: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    conversationId: 'conv-1',
    messageId: '0',
    role: 'assistant',
    chunkIndex: 0,
    order: 0,
    text,
    textHash: `hash-${id}`,
    wordCount: text.split(/\s+/).length,
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
    chunkTextHash: `hash-${chunkId}`,
    status: 'done',
    failureCount: 0,
    embeddedAt: 0,
    ...overrides,
  };
}

const fusedIds = (r: { fused: { chunk: Chunk }[] }) => r.fused.map((f) => f.chunk.id);

describe('hybridRank', () => {
  it('finds the chunk that defines an exact term even when its embedding is far from the query (done-when)', () => {
    const chunks = [
      makeChunk('intro', 'a general overview of how the web service talks to its database', { order: 1 }),
      makeChunk('retries', 'retry failed requests with exponential backoff and jitter', { order: 2 }),
      makeChunk('def', 'pool_pre_ping=True makes SQLAlchemy test a connection before using it', { order: 3 }),
      makeChunk('logging', 'configure structured logging so each request id is recorded', { order: 4 }),
      makeChunk('tests', 'write integration tests against a disposable database container', { order: 5 }),
      makeChunk('deploy', 'deploy the service behind a load balancer with health checks', { order: 6 }),
    ];
    const embeddings = [
      makeEmbedding('intro', [1, 0]),
      makeEmbedding('retries', [0.9, 0.1]),
      makeEmbedding('def', [0, 1]), // orthogonal to the query: the embedding ranks it last
      makeEmbedding('logging', [0.8, 0.2]),
      makeEmbedding('tests', [0.7, 0.3]),
      makeEmbedding('deploy', [0.6, 0.4]),
    ];

    const ranking = hybridRank(chunks, embeddings, [1, 0], 'pool_pre_ping');

    expect(ranking.embeddingList.slice(0, 2).map((r) => r.chunk.id)).not.toContain('def');
    expect(ranking.bm25List[0]!.chunk.id).toBe('def');
    expect(fusedIds(ranking).slice(0, 3)).toContain('def');
  });

  it('puts a chunk that both lists rank first at the top, with both ranks recorded', () => {
    const chunks = [
      makeChunk('a', 'alpha beta', { order: 1 }),
      makeChunk('b', 'gamma delta', { order: 2 }),
    ];
    const embeddings = [makeEmbedding('a', [1, 0]), makeEmbedding('b', [0, 1])];
    const ranking = hybridRank(chunks, embeddings, [1, 0], 'alpha');
    expect(ranking.fused[0]!.chunk.id).toBe('a');
    expect(ranking.fused[0]!.embeddingRank).toBe(1);
    expect(ranking.fused[0]!.bm25Rank).toBe(1);
  });

  it('falls back to BM25 alone when there is no query vector', () => {
    const chunks = [makeChunk('a', 'alpha beta', { order: 1 }), makeChunk('b', 'beta only', { order: 2 })];
    const embeddings = [makeEmbedding('a', [1, 0]), makeEmbedding('b', [0, 1])];
    const ranking = hybridRank(chunks, embeddings, null, 'alpha');
    expect(ranking.embeddingList).toEqual([]);
    expect(fusedIds(ranking)).toEqual(['a']);
  });

  it('still returns BM25 matches for chunks that have no usable embedding', () => {
    const chunks = [
      makeChunk('done', 'unrelated words here', { order: 1 }),
      makeChunk('failed', 'the alpha term lives here', { order: 2 }),
      makeChunk('missing', 'alpha shows up here too', { order: 3 }),
    ];
    const embeddings = [
      makeEmbedding('done', [1, 0]),
      makeEmbedding('failed', [], { status: 'failed' }),
    ];
    const ranking = hybridRank(chunks, embeddings, [1, 0], 'alpha');
    const byId = new Map(ranking.fused.map((f) => [f.chunk.id, f]));
    expect(byId.get('failed')!.embeddingRank).toBeNull();
    expect(byId.get('failed')!.bm25Rank).not.toBeNull();
    expect(byId.get('missing')!.embeddingRank).toBeNull();
    expect(ranking.embeddedCount).toBe(1);
  });

  it('degrades to embedding-only when the highlight is nothing but stopwords', () => {
    const chunks = [makeChunk('a', 'it is what it is', { order: 1 }), makeChunk('b', 'other', { order: 2 })];
    const embeddings = [makeEmbedding('a', [0, 1]), makeEmbedding('b', [1, 0])];
    const ranking = hybridRank(chunks, embeddings, [1, 0], 'it is');
    expect(ranking.queryTerms).toEqual([]);
    expect(ranking.bm25List).toEqual([]);
    expect(fusedIds(ranking)).toEqual(['b', 'a']);
  });

  it('returns empty everything for a conversation with no chunks', () => {
    const ranking = hybridRank([], [], [1, 0], 'alpha');
    expect(ranking.fused).toEqual([]);
    expect(ranking.embeddingList).toEqual([]);
    expect(ranking.bm25List).toEqual([]);
    expect(ranking.chunkCount).toBe(0);
    expect(ranking.embeddedCount).toBe(0);
  });

  it('reports whether the depth cap is binding on each list', () => {
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk(`c${i}`, i === 0 ? 'alpha shared words' : 'shared words only', { order: i }),
    );
    const embeddings = chunks.map((c) => makeEmbedding(c.id, [1, 0]));

    const roomy = hybridRank(chunks, embeddings, [1, 0], 'alpha', 50);
    expect(roomy.capBinding).toEqual({ embedding: false, bm25: false });

    const tight = hybridRank(chunks, embeddings, [1, 0], 'alpha', 3);
    expect(tight.capBinding).toEqual({ embedding: true, bm25: false }); // 5 embedded, but only 1 BM25 match
    expect(tight.embeddingList).toHaveLength(3);
  });

  it('in a chat smaller than the depth, no chunk is "bm25 only" unless it lacks an embedding', () => {
    const chunks = [
      makeChunk('a', 'alpha one', { order: 1 }),
      makeChunk('b', 'beta two', { order: 2 }),
      makeChunk('c', 'alpha three', { order: 3 }),
      makeChunk('d', 'delta four', { order: 4 }),
    ];
    const embeddings = chunks.map((c, i) => makeEmbedding(c.id, [1, i * 0.1]));
    const ranking = hybridRank(chunks, embeddings, [1, 0], 'alpha');
    const rows = buildDebugRows(ranking, 10, new Set());
    expect(rows.some((r) => r.from === 'bm25 only')).toBe(false);
    const both = rows.filter((r) => r.from === 'both');
    expect(both).toHaveLength(2);
    expect(both.every((r) => r.matched === 'alpha')).toBe(true);
    expect(rows.filter((r) => r.from === 'emb only')).toHaveLength(2);
  });

  it('ranks identically with a term cache, cold or warm, and fills the cache', () => {
    const chunks = [
      makeChunk('a', 'alpha beta', { order: 1 }),
      makeChunk('b', 'beta gamma alpha alpha', { order: 2 }),
      makeChunk('c', 'delta', { order: 3 }),
    ];
    const embeddings = chunks.map((c, i) => makeEmbedding(c.id, [1, i * 0.2]));
    const plain = hybridRank(chunks, embeddings, [1, 0], 'alpha beta');

    const cache = new Map();
    const cold = hybridRank(chunks, embeddings, [1, 0], 'alpha beta', undefined, cache);
    expect(cache.size).toBe(3);
    const warm = hybridRank(chunks, embeddings, [1, 0], 'alpha beta', undefined, cache);

    expect(fusedIds(cold)).toEqual(fusedIds(plain));
    expect(fusedIds(warm)).toEqual(fusedIds(plain));
    expect(warm.bm25List.map((r) => r.score)).toEqual(plain.bm25List.map((r) => r.score));
  });

  it('gives the same fused order whatever order the chunks arrive in, even with identical vectors', () => {
    const make = (id: string, order: number) => makeChunk(id, 'same text', { order });
    const c10 = make('c:10:0', 10000);
    const c2 = make('c:2:0', 2000);
    const c3 = make('c:3:0', 3000);
    const embeddings = [c10, c2, c3].map((c) => makeEmbedding(c.id, [1, 0]));

    const inIdOrder = hybridRank([c10, c2, c3], embeddings, [1, 0], 'text');
    const reversed = hybridRank([c3, c2, c10], embeddings, [1, 0], 'text');
    const shuffled = hybridRank([c2, c10, c3], embeddings, [1, 0], 'text');

    expect(fusedIds(inIdOrder)).toEqual(['c:2:0', 'c:3:0', 'c:10:0']);
    expect(fusedIds(reversed)).toEqual(fusedIds(inIdOrder));
    expect(fusedIds(shuffled)).toEqual(fusedIds(inIdOrder));
  });
});

describe('buildDebugRows', () => {
  // A: embedding #1 and BM25 #2.  B: BM25 #1 but no embedding.  C: embedding #2 only.
  const chunks = [
    makeChunk('A', 'alpha beta gamma', { order: 1, messageId: '3', chunkIndex: 1 }),
    makeChunk('B', 'alpha', { order: 2, messageId: '5', chunkIndex: 0 }),
    makeChunk('C', 'delta epsilon zeta', { order: 3, messageId: '7', chunkIndex: 2 }),
  ];
  const embeddings = [makeEmbedding('A', [1, 0]), makeEmbedding('C', [0.5, 0.5])];
  const ranking = hybridRank(chunks, embeddings, [1, 0], 'alpha');

  it('includes the top-k of each list as well as the top-k fused, ordered by fused rank', () => {
    const rows = buildDebugRows(ranking, 1, new Set());
    expect(rows.map((r) => r.chunk)).toEqual(['3:1', '5:0']); // A (fused #1) and B (BM25 #1); C is outside every top-1
    expect(rows.map((r) => r.fusedRank)).toEqual([1, 2]);
  });

  it('labels where each chunk came from and formats ranks and scores', () => {
    const rows = buildDebugRows(ranking, 5, new Set());
    const a = rows.find((r) => r.chunk === '3:1')!;
    const b = rows.find((r) => r.chunk === '5:0')!;
    const c = rows.find((r) => r.chunk === '7:2')!;
    expect(a.from).toBe('both');
    expect(a.embedding).toMatch(/^1 \/ 1\.000$/);
    expect(a.bm25).toMatch(/^2 \/ \d+\.\d\d$/);
    expect(b.from).toBe('bm25 only');
    expect(b.embedding).toBe('–');
    expect(c.from).toBe('emb only');
    expect(c.bm25).toBe('–');
  });

  it('flags chunks from the highlight’s own message', () => {
    const rows = buildDebugRows(ranking, 5, new Set(['3']));
    expect(rows.find((r) => r.chunk === '3:1')!.ownMsg).toBe('yes');
    expect(rows.find((r) => r.chunk === '5:0')!.ownMsg).toBe('');
  });

  it('lists the matched query terms and truncates the preview to 80 characters', () => {
    const long = makeChunk('L', `alpha ${'x'.repeat(200)}`, { order: 9, messageId: '9' });
    const rows = buildDebugRows(hybridRank([long], [], null, 'alpha'), 5, new Set());
    expect(rows[0]!.matched).toBe('alpha');
    expect(rows[0]!.preview).toHaveLength(80);
  });
});

describe('describeLists', () => {
  it('reports counts, list sizes, and that the cap is not binding in a small chat', () => {
    const chunks = [makeChunk('a', 'alpha', { order: 1 }), makeChunk('b', 'beta', { order: 2 })];
    const embeddings = [makeEmbedding('a', [1, 0])];
    const text = describeLists(hybridRank(chunks, embeddings, [1, 0], 'alpha'), 50);
    expect(text).toContain('chunks: 2 (1 embedded)');
    expect(text).toContain('embedding 1');
    expect(text).toContain('bm25 1');
    expect(text).toContain('depth 50');
    expect(text).toContain('cap not binding');
  });

  it('names the lists the cap is binding on', () => {
    const chunks = Array.from({ length: 5 }, (_, i) => makeChunk(`c${i}`, 'alpha', { order: i }));
    const embeddings = chunks.map((c) => makeEmbedding(c.id, [1, 0]));
    const text = describeLists(hybridRank(chunks, embeddings, [1, 0], 'alpha', 3), 3);
    expect(text).toContain('cap binding on: embedding, bm25');
  });
});

describe('excludeMessages', () => {
  const chunks = [
    makeChunk('a', 'one', { messageId: '2' }),
    makeChunk('b', 'two', { messageId: '2', chunkIndex: 1 }),
    makeChunk('c', 'three', { messageId: '5' }),
  ];

  it('removes every chunk of the listed messages and keeps the rest', () => {
    expect(excludeMessages(chunks, new Set(['2'])).map((c) => c.id)).toEqual(['c']);
  });

  it('returns the chunks unchanged when nothing is excluded', () => {
    expect(excludeMessages(chunks, new Set())).toEqual(chunks);
  });
});

describe('hybridRank after excluding a message', () => {
  it('ranks the remaining chunks from 1, as if the excluded message did not exist', () => {
    const chunks = [
      makeChunk('own', 'pool_pre_ping is defined right here', { messageId: '5', order: 5000 }),
      makeChunk('other', 'notes about pool sizing', { messageId: '2', order: 2000 }),
    ];
    const embeddings = [makeEmbedding('own', [1, 0]), makeEmbedding('other', [0.5, 0.5])];
    const query = [1, 0];

    const withOwn = hybridRank(chunks, embeddings, query, 'pool_pre_ping');
    expect(withOwn.embeddingList[0]!.chunk.id).toBe('own');

    const without = hybridRank(excludeMessages(chunks, new Set(['5'])), embeddings, query, 'pool_pre_ping');
    expect(fusedIds(without)).not.toContain('own');
    expect(without.embeddingList.map((r) => r.chunk.id)).toEqual(['other']);
    expect(without.fused[0]!.embeddingRank).toBe(1);
    expect(without.fused[0]!.bm25Rank).toBe(1); // matches via the part "pool"
  });
});
