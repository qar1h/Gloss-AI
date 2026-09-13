import { describe, expect, it } from 'vitest';
import { chunkMessage } from './chunker';
import type { Block } from './types';

const CONV = 'conv-1';

describe('chunkMessage', () => {
  it('keeps a code block whole even past the word ceiling', async () => {
    const longCode = Array.from({ length: 100 }, (_, i) => `line_${i} = ${i}`).join('\n');
    const blocks: Block[] = [
      { type: 'paragraph', text: 'Here is the function you asked for.' },
      { type: 'code', text: longCode },
    ];
    const chunks = await chunkMessage(CONV, '5', 'assistant', blocks);
    const codeChunks = chunks.filter((c) => c.hasCode);
    expect(codeChunks).toHaveLength(1);
    expect(codeChunks[0]?.text).toBe(longCode);
  });

  it('starts a new chunk at a heading, even if the following section is short', async () => {
    const blocks: Block[] = [
      { type: 'paragraph', text: 'x '.repeat(150).trim() },
      { type: 'heading', text: 'Next section' },
      { type: 'paragraph', text: 'Some content after the heading.' },
    ];
    const chunks = await chunkMessage(CONV, '2', 'assistant', blocks);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.text.startsWith('Next section')).toBe(true);
  });

  it('folds a small trailing leftover into the previous chunk', async () => {
    const blocks: Block[] = [
      { type: 'paragraph', text: 'x '.repeat(170).trim() },
      { type: 'paragraph', text: 'one two three four five six seven eight nine ten eleven twelve' },
    ];
    const chunks = await chunkMessage(CONV, '3', 'assistant', blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('twelve');
  });

  it('never duplicates text from nested blocks once the adapter has de-duplicated them', async () => {
    const blocks: Block[] = [
      { type: 'blockquote', text: 'A quoted paragraph in full.' },
      { type: 'list-item', text: '1.' },
      { type: 'code', text: 'print("hi")' },
    ];
    const chunks = await chunkMessage(CONV, '4', 'assistant', blocks);
    const combined = chunks.map((c) => c.text).join('\n');
    expect(combined.match(/A quoted paragraph in full\./g)).toHaveLength(1);
    expect(combined.match(/print\("hi"\)/g)).toHaveLength(1);
  });

  it('never mixes text from two different messages', async () => {
    const chunksA = await chunkMessage(CONV, '0', 'user', [{ type: 'paragraph', text: 'Message A content.' }]);
    const chunksB = await chunkMessage(CONV, '1', 'assistant', [{ type: 'paragraph', text: 'Message B content.' }]);
    expect(chunksA.every((c) => c.messageId === '0')).toBe(true);
    expect(chunksB.every((c) => c.messageId === '1')).toBe(true);
    expect(chunksA.some((c) => c.text.includes('Message B'))).toBe(false);
    expect(chunksB.some((c) => c.text.includes('Message A'))).toBe(false);
  });
});
