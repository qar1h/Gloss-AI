// prepareExplainPrompt is the I/O layer between the chat index and the pure assembler. Its storage,
// embedder and site dependencies are mocked here so the ORDER of events can be controlled: what
// matters is what the prompt contains when the chat's numbering changes while it is being built.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeChunk, makeFocal } from './test-helpers';
import type { OrderStatus } from './types';

const state = vi.hoisted(() => ({
  currentGeneration: 'g1' as string | null,
  chunks: [] as unknown[],
  fused: [] as unknown[],
  ensureCalls: [] as (string | null | undefined)[],
  readCalls: 0,
  onEmbed: null as null | (() => void),
  onRead: null as null | (() => void),
  onSearch: null as null | (() => void),
}));

vi.mock('@/sites', () => ({
  getAdapter: () => ({ getIndexGeneration: () => state.currentGeneration }),
}));
vi.mock('@/rag/store', () => ({
  getAllChunks: async () => {
    state.readCalls++;
    state.onRead?.();
    return state.chunks;
  },
  getAllEmbeddings: async () => [],
}));
vi.mock('@/rag/generation', () => ({
  ensureIndexGeneration: async (_conversationId: string, generation: string | null | undefined) => {
    state.ensureCalls.push(generation);
  },
}));
vi.mock('@/rag/coverage', () => ({ getCoverage: async () => ({ indexedMessages: 3, totalMessages: null }) }));
vi.mock('@/rag/embedder', () => ({
  embedTexts: async () => {
    state.onEmbed?.();
    return [[1, 0]];
  },
}));
vi.mock('@/rag/hybrid', async () => {
  const actual = await vi.importActual<typeof import('@/rag/hybrid')>('@/rag/hybrid');
  return {
    ...actual,
    hybridSearch: async () => {
      state.onSearch?.();
      return { fused: state.fused };
    },
  };
});

import { prepareExplainPrompt } from './gather';

const settings = { promptBudgetTokens: 6000, fullChatThresholdTokens: 6000, retrievalK: 8 } as never;
const EXCERPT = 'EXCERPT-FROM-THE-INDEX-xyz';

function ordered(generation: string | null, note: string | null = null): OrderStatus {
  return { retrieval: 'ok', note, indexGeneration: generation };
}

function indexOneChunk() {
  const chunk = makeChunk('3', 0, EXCERPT);
  state.chunks = [chunk];
  state.fused = [{ chunk, embeddingRank: 1, bm25Rank: 1 }];
}

beforeEach(() => {
  state.currentGeneration = 'g1';
  state.chunks = [];
  state.fused = [];
  state.ensureCalls = [];
  state.readCalls = 0;
  state.onEmbed = null;
  state.onRead = null;
  state.onSearch = null;
  indexOneChunk();
});

describe('prepareExplainPrompt: the normal case', () => {
  it('uses the index when the numbering is the one the focal was read under', async () => {
    const prepared = await prepareExplainPrompt('chat', makeFocal({ orderStatus: ordered('g1') }), settings, { mode: 'retrieval' });
    expect(prepared.assembled.prompt).toContain(EXCERPT);
    expect(prepared.assembled.report.orderNote).toBeNull();
    expect(state.ensureCalls).toEqual(['g1']);
  });

  it('is unchanged for a site with no generations (claude.ai): the index is used and never wiped', async () => {
    state.currentGeneration = 'something-else-entirely';
    const prepared = await prepareExplainPrompt('chat', makeFocal(), settings, { mode: 'retrieval' });
    expect(prepared.assembled.prompt).toContain(EXCERPT);
    expect(state.ensureCalls).toEqual([null]);
  });

  it('does not read the index at all when retrieval is disabled for this window', async () => {
    const focal = makeFocal({ orderStatus: { retrieval: 'disabled', note: 'not connected', indexGeneration: 'g1' } });
    const prepared = await prepareExplainPrompt('chat', focal, settings, { mode: 'retrieval' });
    expect(state.readCalls).toBe(0);
    expect(prepared.assembled.prompt).not.toContain(EXCERPT);
  });
});

describe('prepareExplainPrompt: the chat is renumbered while the prompt is being built (F1)', () => {
  const NOTE = /changed while this explanation was being prepared/;

  it('does not mix numberings when it happens during the query embedding', async () => {
    // The ids in the focal belong to g1. Between the click and the search, a conflict made the
    // adapter renumber the chat (g2) and the indexer rewrote the rows. Whatever the search
    // returns now is numbered under g2 and must not be placed beside g1 ids.
    state.onEmbed = () => {
      state.currentGeneration = 'g2';
    };
    const prepared = await prepareExplainPrompt('chat', makeFocal({ orderStatus: ordered('g1') }), settings, { mode: 'retrieval' });
    expect(prepared.assembled.prompt).not.toContain(EXCERPT);
    expect(prepared.assembled.report.orderNote).toMatch(NOTE);
    expect(prepared.assembled.report.includedChunkIds).toEqual([]);
  });

  it('does not use chunks read just before the renumbering (full-chat mode)', async () => {
    state.onRead = () => {
      state.currentGeneration = 'g2';
    };
    const prepared = await prepareExplainPrompt('chat', makeFocal({ orderStatus: ordered('g1') }), settings);
    expect(prepared.assembled.prompt).not.toContain(EXCERPT);
    expect(prepared.assembled.report.orderNote).toMatch(NOTE);
  });

  it('does not use results that arrive after the renumbering, even if the embedding was fine', async () => {
    state.onSearch = () => {
      state.currentGeneration = 'g2';
    };
    const prepared = await prepareExplainPrompt('chat', makeFocal({ orderStatus: ordered('g1') }), settings, { mode: 'retrieval' });
    expect(prepared.assembled.prompt).not.toContain(EXCERPT);
    expect(prepared.assembled.report.orderNote).toMatch(NOTE);
  });

  it('never asks the gate to apply a numbering that is already out of date', async () => {
    state.currentGeneration = 'g2'; // the chat was renumbered between reading the page and getting here
    const prepared = await prepareExplainPrompt('chat', makeFocal({ orderStatus: ordered('g1') }), settings, { mode: 'retrieval' });
    expect(state.ensureCalls).toEqual([]); // applying g1 now would wipe the g2 rows the indexer is writing
    expect(state.readCalls).toBe(0);
    expect(prepared.assembled.prompt).not.toContain(EXCERPT);
    expect(prepared.assembled.report.orderNote).toMatch(NOTE);
  });

  it('keeps a note the adapter already supplied, and adds to it', async () => {
    state.onEmbed = () => {
      state.currentGeneration = 'g2';
    };
    const focal = makeFocal({ orderStatus: ordered('g1', 'this chat changed earlier on this page') });
    const prepared = await prepareExplainPrompt('chat', focal, settings, { mode: 'retrieval' });
    expect(prepared.assembled.report.orderNote).toMatch(/changed earlier on this page/);
    expect(prepared.assembled.report.orderNote).toMatch(NOTE);
  });
});
