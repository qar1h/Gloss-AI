// Golden test: pins what the claude.ai adapter returns on the real captured fixtures, so a
// refactor of claude.ts (v8 moves things behind SiteAdapter) cannot change claude.ai's
// behaviour without a test failing. It stores hashes and shapes, never fixture text, so no
// chat content is copied into a new file.
//
// If this fails after a change you MEANT to make to Claude's extraction, regenerate the
// snapshot (`npx vitest run -u src/sites/claude.golden.test.ts`) and say so in the commit.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SiteAdapter } from './types';

let adapter: SiteAdapter;

beforeAll(async () => {
  // claude.ts reads the global `document` / `Node` / `location` at call time; give it a DOM first.
  loadDom('<div></div>');
  adapter = (await import('./claude')).claudeAdapter;
});

function loadDom(bodyHtml: string, pathname = '/chat/test-conversation'): Document {
  const { document, window } = parseHTML(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = document;
  g.Node = (window as unknown as { Node: unknown }).Node;
  g.location = { pathname };
  return document as unknown as Document;
}

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../fixtures', name), 'utf8');
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/** Wraps a fragment fixture in the minimal row the adapter expects. */
function asRow(index: number, role: 'human' | 'assistant', inner: string): string {
  return `<div data-testid="transcript-row" data-index="${index}" data-perf-row="${role}" data-perf-row-streaming="false">${inner}</div>`;
}

function fakeRangeIn(el: Element): Range {
  return { commonAncestorContainer: el, toString: () => el.textContent ?? '' } as unknown as Range;
}

function summarize() {
  const messages = adapter.getAllMessages();
  return {
    conversationId: adapter.getConversationId(),
    lastPosition: adapter.getLastMessagePosition(),
    unrecognized: adapter.getUnrecognizedRowIds(),
    messages: messages.map((m) => {
      const blocks = adapter.getMessageBlocks(m.element);
      const firstBlockEl = m.element.querySelector('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre');
      const question = m.role === 'assistant' ? adapter.getUserQuestionFor(m.id) : null;
      const recent = adapter.getRecentMessages(m.id, 3);
      return {
        id: m.id,
        role: m.role,
        streaming: adapter.isStreaming(m.element),
        textSha: sha(adapter.getMessageText(m.element)),
        contentSha: sha(adapter.getMessageContent(m.element)),
        blockTypes: blocks.map((b) => b.type),
        blocksSha: sha(JSON.stringify(blocks)),
        paragraphSha: firstBlockEl ? sha(adapter.getParagraphAround(fakeRangeIn(firstBlockEl))) : null,
        question: question && {
          status: question.status,
          id: question.message?.id ?? null,
          textSha: question.message ? sha(question.message.text) : null,
        },
        recent: {
          ids: recent.messages.map((r) => r.id),
          textShas: recent.messages.map((r) => sha(r.text)),
          endsAtGap: recent.endsAtGap,
        },
      };
    }),
  };
}

describe('claude adapter on captured fixtures (golden)', () => {
  it('short-chat.html (4 real rows)', () => {
    loadDom(fixture('short-chat.html'));
    const result = summarize();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result).toMatchSnapshot();
  });

  it('long-chat-with-code.html (hand-built rows with code blocks)', () => {
    loadDom(fixture('long-chat-with-code.html'));
    const result = summarize();
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result).toMatchSnapshot();
  });

  it('claude-message.html (one assistant answer, wrapped in a row)', () => {
    loadDom(asRow(1, 'assistant', `<div data-cds="Prose">${fixture('claude-message.html')}</div>`));
    expect(summarize()).toMatchSnapshot();
  });

  it('claude-code-message.html (an answer that is a code block, wrapped in a row)', () => {
    loadDom(asRow(1, 'assistant', `<div data-cds="Prose"><div data-perf-reply-text="">${fixture('claude-code-message.html')}</div></div>`));
    const result = summarize();
    expect(result.messages[0]?.blockTypes).toContain('code');
    expect(result).toMatchSnapshot();
  });

  it('claude-user-message.html (one user message, wrapped in a row)', () => {
    loadDom(asRow(0, 'human', fixture('claude-user-message.html')));
    expect(summarize()).toMatchSnapshot();
  });

  it('a gap in the mounted rows is reported, not bridged (the v5 island bug)', () => {
    const doc = loadDom(fixture('short-chat.html'));
    const rows = Array.from(doc.querySelectorAll('[data-testid="transcript-row"]'));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    rows[1]!.remove(); // message 1 "unmounts": row 2's DOM neighbour is now row 0
    expect(summarize()).toMatchSnapshot();
  });
});
