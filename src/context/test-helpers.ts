// Builders for tests only. Not imported by any production module.

import type { Chunk } from '../rag/types';
import type { FocalInput } from './types';

export function makeChunk(messageId: string, chunkIndex: number, text: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: `c:${messageId}:${chunkIndex}`,
    conversationId: 'c',
    messageId,
    role: 'assistant',
    chunkIndex,
    order: Number(messageId) * 1000 + chunkIndex,
    text,
    textHash: `h:${messageId}:${chunkIndex}`,
    wordCount: text.split(/\s+/).length,
    hasCode: false,
    createdAt: 0,
    ...overrides,
  };
}

export function makeFocal(overrides: Partial<FocalInput> = {}): FocalInput {
  return {
    highlight: 'pool_pre_ping',
    paragraph: 'Set pool_pre_ping to test connections before use.',
    source: {
      id: '12',
      role: 'assistant',
      text: 'Intro. Set pool_pre_ping to test connections before use. Outro.',
    },
    question: { id: '11', role: 'user', text: 'How do I keep connections healthy?' },
    recent: [{ id: '10', role: 'assistant', text: 'Earlier answer.' }],
    demotedRecent: [],
    questionStatus: 'found',
    recentShortfall: null,
    ...overrides,
  };
}
