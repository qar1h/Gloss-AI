// The indexing pass is the I/O loop that turns the page into stored chunks and vectors. Its storage,
// embedder, settings and site are replaced here by an in-memory store and a controllable adapter, so
// the ORDER of events (a navigation during an await, another tab wiping the rows, the page reusing
// an element) can be set up exactly. Each test uses its own conversation id because the indexer
// keeps some state per conversation for the life of the module.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chunk, EmbeddingRecord, MessageRecord } from './types';

interface FakeMessage {
  id: string;
  role: 'user' | 'assistant';
  element: { text: string };
}

const h = vi.hoisted(() => {
  const db = {
    records: new Map<string, unknown>(),
    chunks: new Map<string, unknown>(),
    embeddings: new Map<string, unknown>(),
  };
  const hooks = {
    onSettings: null as null | (() => void),
    onGetRecord: null as null | (() => void),
  };
  const adapterState = {
    conversationId: 'A~1' as string | null,
    messages: [] as unknown[],
    generation: null as string | null,
    isMessageCurrent: undefined as undefined | ((m: unknown) => boolean),
  };
  const embedCalls: string[][] = [];
  return { db, hooks, adapterState, embedCalls };
});

vi.mock('@/sites', () => ({
  requireAdapter: () => ({
    getConversationId: () => h.adapterState.conversationId,
    getAllMessages: () => h.adapterState.messages,
    getIndexGeneration: () => h.adapterState.generation,
    isStreaming: () => false,
    getMessageText: (el: { text: string }) => el.text,
    getMessageBlocks: (el: { text: string }) => [{ type: 'paragraph', text: el.text }],
    getLastMessagePosition: () => null,
    getUnrecognizedRowIds: () => [],
    getTranscriptRoot: () => null,
    observedAttributes: [],
    ...(h.adapterState.isMessageCurrent ? { isMessageCurrent: h.adapterState.isMessageCurrent } : {}),
  }),
}));
vi.mock('@/options/storage', () => ({
  getSettings: async () => {
    h.hooks.onSettings?.();
    return { debugEnabled: false, retrievalK: 8 };
  },
}));
vi.mock('./embedder', () => ({
  EMBEDDING_VERSION: 1,
  embedTexts: async (texts: string[]) => {
    h.embedCalls.push(texts);
    return texts.map(() => [1, 0]);
  },
}));
vi.mock('./store', () => {
  const { db, hooks } = h;
  const byConversation = <T extends { conversationId: string }>(map: Map<string, unknown>, id: string) =>
    [...map.values()].filter((v) => (v as T).conversationId === id) as T[];
  return {
    getMessageRecord: async (key: string) => {
      hooks.onGetRecord?.();
      return db.records.get(key);
    },
    getAllMessageRecords: async (id: string) => byConversation(db.records, id),
    getMessageRecordsByPrefix: async (prefix: string) =>
      [...db.records.values()].filter((v) => (v as { conversationId: string }).conversationId.startsWith(prefix)),
    getAllChunks: async (id: string) => byConversation(db.chunks, id),
    getAllEmbeddings: async (id: string) => byConversation(db.embeddings, id),
    putEmbedding: async (e: { chunkId: string }) => void db.embeddings.set(e.chunkId, e),
    deleteEmbedding: async (id: string) => void db.embeddings.delete(id),
    replaceMessage: async (record: { key: string; chunkIds: string[] }, chunks: { id: string }[], previous: string[]) => {
      const keep = new Set(chunks.map((c) => c.id));
      for (const id of previous) {
        db.chunks.delete(id);
        if (!keep.has(id)) db.embeddings.delete(id);
      }
      db.records.set(record.key, record);
      for (const c of chunks) db.chunks.set(c.id, c);
    },
    deleteMessage: async (record: { key: string; chunkIds: string[] }) => {
      for (const id of record.chunkIds) {
        db.chunks.delete(id);
        db.embeddings.delete(id);
      }
      db.records.delete(record.key);
    },
  };
});

import { runIndexPass } from './indexer';

const msg = (id: string, text: string, role: 'user' | 'assistant' = 'assistant'): FakeMessage => ({ id, role, element: { text } });
const records = (conversationId: string) =>
  [...h.db.records.values()].filter((r) => (r as MessageRecord).conversationId === conversationId) as MessageRecord[];
const embeddings = (conversationId: string) =>
  [...h.db.embeddings.values()].filter((e) => (e as EmbeddingRecord).conversationId === conversationId) as EmbeddingRecord[];
void ({} as Chunk);

beforeEach(() => {
  h.db.records.clear();
  h.db.chunks.clear();
  h.db.embeddings.clear();
  h.embedCalls.length = 0;
  h.hooks.onSettings = null;
  h.hooks.onGetRecord = null;
  h.adapterState.conversationId = 'A~1';
  h.adapterState.messages = [];
  h.adapterState.generation = null;
  h.adapterState.isMessageCurrent = undefined;
});

describe('runIndexPass: the normal case', () => {
  it('indexes what the page shows under the page\'s conversation id and embeds the chunks', async () => {
    h.adapterState.conversationId = 'normal~1';
    h.adapterState.messages = [msg('10', 'First message about pools.'), msg('11', 'Second message about engines.')];
    await runIndexPass();
    expect(records('normal~1').map((r) => r.messageId).sort()).toEqual(['10', '11']);
    expect(embeddings('normal~1')).toHaveLength(2);
  });

  it('does not touch the index on a site with no generations', async () => {
    h.adapterState.conversationId = 'claudelike';
    h.adapterState.messages = [msg('0', 'hello there friend')];
    await runIndexPass();
    expect(records('claudelike')).toHaveLength(1);
  });
});

describe('runIndexPass: F7 - the chat is read in the same tick as its messages', () => {
  it('does not file chat B\'s messages under chat A when the page navigates during the settings await', async () => {
    h.adapterState.conversationId = 'chatA~1';
    h.adapterState.messages = [msg('10', 'a message that belongs to chat A')];
    h.hooks.onSettings = () => {
      // The user switches chats while the pass is waiting for its settings.
      h.adapterState.conversationId = 'chatB~1';
      h.adapterState.messages = [msg('10', 'a message that belongs to chat B')];
    };
    await runIndexPass();
    expect(records('chatA~1')).toEqual([]); // nothing of B under A
    expect(records('chatB~1').map((r) => r.messageId)).toEqual(['10']);
  });
});

describe('runIndexPass: F2 - rows purged by another tab', () => {
  it('re-embeds chunks whose rows were deleted behind this tab\'s back', async () => {
    h.adapterState.conversationId = 'purged~1';
    h.adapterState.messages = [msg('10', 'A message that gets embedded once.')];
    await runIndexPass();
    expect(embeddings('purged~1')).toHaveLength(1);
    expect(h.embedCalls).toHaveLength(1);

    // Another tab of the same chat starts and removes this tab's rows (generation.ts purges earlier loads).
    h.db.records.clear();
    h.db.chunks.clear();
    h.db.embeddings.clear();

    await runIndexPass(); // the page still shows the message: it is chunked again
    expect(records('purged~1')).toHaveLength(1);
    // Without a vector the chunk could never be found by meaning again, and nothing would say so.
    expect(embeddings('purged~1')).toHaveLength(1);
    expect(h.embedCalls).toHaveLength(2);
  });
});

describe('runIndexPass: F5 - the element is not the message any more', () => {
  const current = (value: boolean) => () => value;

  it('writes nothing for a message whose element the page has handed to another turn', async () => {
    h.adapterState.conversationId = 'reused~1';
    h.adapterState.messages = [msg('10', 'Text that now belongs to some other turn.')];
    h.adapterState.isMessageCurrent = current(false);
    await runIndexPass();
    expect(records('reused~1')).toEqual([]);
    expect(embeddings('reused~1')).toEqual([]);
  });

  it('notices it during the pass: the element is fine at first and reused while the pass awaits', async () => {
    h.adapterState.conversationId = 'reused~2';
    h.adapterState.messages = [msg('10', 'Text that is read, then the element is reused.')];
    let ok = true;
    h.adapterState.isMessageCurrent = () => ok;
    h.hooks.onGetRecord = () => {
      ok = false; // the virtualizer reuses the element while the pass is awaiting IndexedDB
    };
    await runIndexPass();
    expect(records('reused~2')).toEqual([]);
  });

  it('indexes normally while the element is still the message', async () => {
    h.adapterState.conversationId = 'reused~3';
    h.adapterState.messages = [msg('10', 'Text that stays put in its element.')];
    h.adapterState.isMessageCurrent = current(true);
    await runIndexPass();
    expect(records('reused~3')).toHaveLength(1);
  });
});
