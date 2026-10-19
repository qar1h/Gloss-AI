// ChatGPT renders some answers WITHOUT the [data-dil-message-id] renderer: the blocks (headings,
// paragraphs, tables) are direct children of the `[data-markdown-text-style="assistant-message"]`
// element (fixtures/chatgpt-other-answer.html, a real capture; live, every answer of that chat looked
// like this). In the layout we already had, the same element wraps the renderer. So that element is
// the anchor for an answer in both layouts. These tests assert structure and counts only: the
// fixture is a real chat, and none of its text is copied into this file. (The fixture was
// reformatted when saved, so whitespace inside it is not trusted; its structure is.)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import { assistantBlocks } from './chatgptBlocks';
import type { SiteAdapter } from './types';

const fixture = (name: string) => readFileSync(resolve(__dirname, '../../fixtures', name), 'utf8');
const ANSWER = '[data-markdown-text-style="assistant-message"]';

function load(html: string, pathname: string): Document {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = document;
  g.location = { pathname };
  return document as unknown as Document;
}

const otherHtml = fixture('chatgpt-other-answer.html');
const parse = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document;

describe('the other renderer: what the fixture really contains', () => {
  it('has one turn whose answer has the wrapper and no [data-dil-message-id] renderer', () => {
    const doc = parse(otherHtml);
    expect(doc.querySelectorAll('[data-turn-key]')).toHaveLength(1);
    expect(doc.querySelectorAll(ANSWER)).toHaveLength(1);
    expect(doc.querySelectorAll('[data-dil-message-id]')).toHaveLength(0);
    expect(doc.querySelector(ANSWER)!.querySelector(':scope > h3, :scope > h2, :scope > h1')).not.toBeNull();
  });
});

describe('blocks of an answer in the other renderer', () => {
  const doc = parse(otherHtml);
  const answer = doc.querySelector(ANSWER)!;
  const blocks = assistantBlocks(answer);

  it('keeps every heading, as a heading', () => {
    expect(blocks.filter((b) => b.type === 'heading')).toHaveLength(answer.querySelectorAll('h1,h2,h3,h4,h5,h6').length);
  });

  it('turns every table row into one row block, cells joined, never the table toolbar', () => {
    const rows = Array.from(answer.querySelectorAll('tr'));
    const rowBlocks = blocks.filter((b) => b.type === 'list-item');
    expect(rowBlocks).toHaveLength(rows.length);
    for (const b of rowBlocks) expect(b.text).toContain(' | ');
    const all = blocks.map((b) => b.text).join('\n');
    expect(all).not.toContain('Copy table');
    expect(all).not.toContain('Expand table');
  });

  it('loses no prose: every longer word of the visible answer is in some block', () => {
    const clone = answer.cloneNode(true) as Element;
    clone.querySelectorAll('[data-markdown-copy="exclude"], svg, button').forEach((n) => n.remove());
    const words = (clone.textContent ?? '').split(/\s+/).filter((w) => /^[A-Za-z]{5,}$/.test(w));
    expect(words.length).toBeGreaterThan(20);
    const text = blocks.map((b) => b.text).join(' ');
    expect(words.filter((w) => !text.includes(w))).toEqual([]);
    expect(blocks.every((b) => b.text.trim().length > 0)).toBe(true);
  });
});

describe('the adapter on an answer in the other renderer', () => {
  let adapter: SiteAdapter;
  const chat = parse(otherHtml).querySelector<HTMLElement>('[data-chatgpt-selection-conversation-id]')!.dataset.chatgptSelectionConversationId!;

  beforeAll(async () => {
    load('<div></div>', '/');
    adapter = (await import('./chatgpt')).chatgptAdapter;
  });

  it('finds the question and the answer as messages', () => {
    load(otherHtml, `/c/${chat}`);
    const messages = adapter.getAllMessages();
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]!.element.matches(ANSWER)).toBe(true);
  });

  it('explains a word in a heading instead of calling it an unfamiliar layout (the B5 failure)', () => {
    const doc = load(otherHtml, `/c/${chat}`);
    const heading = doc.querySelector(`${ANSWER} h3`)!;
    const hit = adapter.getMessageForNode(heading.firstChild ?? heading);
    expect(hit?.role).toBe('assistant');
    expect(adapter.explainBlockedReason!(heading)).toBeNull();
    expect(adapter.getUserQuestionFor(hit!.id).status).toBe('found');
    expect(adapter.getMessageContent(hit!.element).length).toBeGreaterThan(200);
  });
});

describe('the layout we already had still reads exactly as before', () => {
  it('gives the same blocks from the wrapper as from the renderer inside it, on all three real answers', () => {
    const doc = parse(fixture('chatgpt-conversation.html'));
    const wrappers = Array.from(doc.querySelectorAll(ANSWER));
    expect(wrappers).toHaveLength(3);
    for (const wrapper of wrappers) {
      expect(assistantBlocks(wrapper)).toEqual(assistantBlocks(wrapper.querySelector('[data-dil-message-id]')!));
    }
  });
});
