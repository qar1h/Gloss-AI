// The real wipe behind the generation gate, with an in-memory store. What matters here is WHEN it
// removes other page loads' rows of the same chat: once, when a load first uses the index. The
// first version purged on every wipe, so a conflict in one tab deleted the rows a second tab had
// just written (and left that tab believing its chunks were still embedded).

import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ records: [] as { key: string; conversationId: string; chunkIds: string[] }[] }));

vi.mock('./store', () => ({
  getAllMessageRecords: async (id: string) => rows.records.filter((r) => r.conversationId === id),
  getMessageRecordsByPrefix: async (prefix: string) => rows.records.filter((r) => r.conversationId.startsWith(prefix)),
  deleteMessage: async (record: { key: string }) => {
    rows.records = rows.records.filter((r) => r.key !== record.key);
  },
}));

import { ensureIndexGeneration } from './generation';

const add = (conversationId: string, n = 1) => {
  for (let i = 0; i < n; i++) rows.records.push({ key: `${conversationId}:${i}`, conversationId, chunkIds: [] });
};
const left = (conversationId: string) => rows.records.filter((r) => r.conversationId === conversationId).length;

describe('ensureIndexGeneration (the real wipe)', () => {
  it('on a load\'s first use, removes its own old rows and the rows of earlier loads of the same chat', async () => {
    rows.records = [];
    add('chat1~old', 2);
    add('chat1~new', 1);
    add('chat2~other', 1);
    await ensureIndexGeneration('chat1~new', 'g1');
    expect(left('chat1~new')).toBe(0);
    expect(left('chat1~old')).toBe(0);
    expect(left('chat2~other')).toBe(1); // another chat is never touched
  });

  it('does not purge other loads again when this load\'s numbering is reset later', async () => {
    rows.records = [];
    await ensureIndexGeneration('chat3~mine', 'g1');
    add('chat3~tab2', 2); // another tab starts, and indexes
    add('chat3~mine', 1);
    await ensureIndexGeneration('chat3~mine', 'g2'); // a conflict here renumbers this load only
    expect(left('chat3~mine')).toBe(0); // this load's own rows are gone (new numbering)
    expect(left('chat3~tab2')).toBe(2); // the other tab's rows are not
  });

  it('leaves a plain conversation id (claude.ai) alone beyond its own rows', async () => {
    rows.records = [];
    add('plainchat', 1);
    add('plainchat2', 1);
    await ensureIndexGeneration('plainchat', 'g1');
    expect(left('plainchat')).toBe(0);
    expect(left('plainchat2')).toBe(1); // no prefix, so no sibling purge
  });
});
