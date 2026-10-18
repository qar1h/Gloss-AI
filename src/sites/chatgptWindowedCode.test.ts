// ChatGPT's code blocks are CodeMirror editors, and CodeMirror only renders the lines near the
// viewport: the rest is a `.cm-gap` spacer with an explicit height. Read as plain lines, a long
// block is indexed PARTIALLY and nothing says so (a well-formed chunk with half the code missing),
// and its text changes as the page scrolls (a new hash, a re-embed of a different slice).
//
// fixtures/chatgpt-long-code.html is a real, raw (not pretty-printed) capture of such a block in its
// windowed state: 73 rendered lines, one gap after the first line and one at the end. Block size and
// gap heights come from live probes: complete blocks (15 and 18 lines) had no gap, every block stuck
// at 36 lines had exactly one.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CODE_ABOVE_NOT_ON_PAGE,
  CODE_BELOW_NOT_ON_PAGE,
  CODE_BETWEEN_NOT_ON_PAGE,
  PARTIAL_CODE_PLACEHOLDER,
  assistantBlocks,
  blockElementText,
  hasUnreadCode,
  hasWindowedCode,
} from './chatgptBlocks';
import type { SiteAdapter } from './types';

const fixture = (name: string) => readFileSync(resolve(__dirname, '../../fixtures', name), 'utf8');
const parse = (html: string): Document =>
  parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document;

function longCode(): { doc: Document; root: Element; block: Element; lines: Element[] } {
  const doc = parse(fixture('chatgpt-long-code.html'));
  const block = doc.querySelector('[data-code-block]')!;
  return { doc, root: block.parentElement!.parentElement!, block, lines: Array.from(block.querySelectorAll('.cm-line')) };
}

describe('the long-code fixture really is in the windowed state', () => {
  it('has one block with 73 rendered lines and two gaps that sit between and after them', () => {
    const { block, lines } = longCode();
    const kids = Array.from(block.querySelector('.cm-content')!.children);
    expect(lines).toHaveLength(73);
    expect(block.querySelectorAll('.cm-gap')).toHaveLength(2);
    expect(kids.map((k) => (k.matches('.cm-gap') ? 'gap' : 'line')).join(',').replace(/(line,)+/g, 'lines,')).toBe('lines,gap,lines,gap');
    expect(block.querySelector('.cm-gap')!.getAttribute('style')).toMatch(/height: \d+px/);
  });
});

describe('a windowed code block is never read as if it were the whole block', () => {
  it('becomes one constant placeholder, and none of the rendered code leaks into the blocks', () => {
    const { root, lines } = longCode();
    const blocks = assistantBlocks(root);
    expect(blocks).toEqual([{ type: 'paragraph', text: PARTIAL_CODE_PLACEHOLDER }]);
    const sample = lines.map((l) => (l.textContent ?? '').trim()).find((t) => t.length >= 12)!;
    expect(JSON.stringify(blocks)).not.toContain(sample);
  });

  it('gives the same blocks when the window moves (the page scrolled), so nothing is re-chunked or re-embedded', () => {
    const before = longCode();
    const reference = assistantBlocks(before.root);
    const after = longCode();
    for (const line of after.lines.slice(30, 46)) line.remove(); // other lines are rendered now
    after.block.querySelector('.cm-gap')!.setAttribute('style', 'height: 99999px;');
    expect(after.block.querySelectorAll('.cm-line').length).toBeLessThan(73);
    expect(assistantBlocks(after.root)).toEqual(reference);
  });

  it('keeps the placeholder in order between the prose around it', () => {
    const { block } = longCode();
    const doc = parse(`<p>Here is the file:</p>${block.outerHTML}<p>That was it.</p>`);
    const blocks = assistantBlocks(doc.body);
    expect(blocks.map((b) => b.text)).toEqual(['Here is the file:', PARTIAL_CODE_PLACEHOLDER, 'That was it.']);
  });

  it('keeps it in place inside a list item, after the item text', () => {
    const { block } = longCode();
    const doc = parse(`<ol><li><p>Run this:</p>${block.outerHTML}</li></ol>`);
    expect(assistantBlocks(doc.body)).toEqual([
      { type: 'list-item', text: 'Run this:' },
      { type: 'paragraph', text: PARTIAL_CODE_PLACEHOLDER },
    ]);
  });

  it('does not touch a complete block (no gap): it is still read in full', () => {
    const doc = parse('<div data-code-block="true"><div class="cm-content"><div class="cm-line">a = 1</div><div class="cm-line"> b = 2</div></div></div>');
    expect(assistantBlocks(doc.body)).toEqual([{ type: 'code', text: 'a = 1\n b = 2' }]);
  });
});

describe('a code block that has rendered nothing yet', () => {
  it('is reported with the placeholder instead of being dropped or crashing', () => {
    const unrendered = '<div data-code-block="true"><div class="cm-editor"><div class="cm-content"></div></div></div>';
    expect(assistantBlocks(parse(unrendered).body)).toEqual([{ type: 'paragraph', text: PARTIAL_CODE_PLACEHOLDER }]);
    const noEditor = '<div data-code-block="true"><pre></pre></div>';
    expect(assistantBlocks(parse(noEditor).body)).toEqual([{ type: 'paragraph', text: PARTIAL_CODE_PLACEHOLDER }]);
  });
});

describe('hasWindowedCode', () => {
  it('is true for the windowed fixture and false for every complete block we have captured', () => {
    expect(hasWindowedCode(longCode().root)).toBe(true);
    const conversation = parse(fixture('chatgpt-conversation.html'));
    for (const root of Array.from(conversation.querySelectorAll('[data-dil-message-id]'))) expect(hasWindowedCode(root)).toBe(false);
    expect(hasWindowedCode(parse(fixture('chatgpt-code-message.html')).body)).toBe(false);
  });
});

describe('hasUnreadCode: any code the answer will not have seen', () => {
  const unrendered = '<div data-code-block="true"><div class="cm-editor"><div class="cm-content"></div></div></div>';
  const complete = '<div data-code-block="true"><div class="cm-content"><div class="cm-line">x = 1</div></div></div>';
  const staticPre = '<div data-code-block="true"><pre>int main() {}</pre></div>';
  const staticCode = '<div data-code-block="true"><div data-code-block-source="true"><code>Palindrome</code></div></div>';

  it('is true for a windowed block and for a block with nothing rendered yet', () => {
    expect(hasUnreadCode(longCode().root)).toBe(true);
    expect(hasUnreadCode(parse(unrendered).body)).toBe(true);
  });

  it('is false for complete blocks in every shape we have seen (editor lines, <pre>, bare <code>)', () => {
    for (const html of [complete, staticPre, staticCode]) expect(hasUnreadCode(parse(html).body)).toBe(false);
  });

  it('is true as soon as one block of several is unread', () => {
    expect(hasUnreadCode(parse(complete + unrendered + staticPre).body)).toBe(true);
  });
});

describe('the paragraph around a highlight inside a windowed block', () => {
  // Lines the user can see are always rendered, so the highlight's neighbourhood is real code.
  // But rendered lines on either side of a gap are NOT adjacent, so they must never be joined.
  it('is the run of rendered lines around the highlight, with a marker where code continues off the page', () => {
    const { block, lines } = longCode();
    const text = blockElementText(block, lines[40]!);
    const rows = text.split('\n');
    expect(rows[0]).toBe(CODE_ABOVE_NOT_ON_PAGE);
    expect(rows[rows.length - 1]).toBe(CODE_BELOW_NOT_ON_PAGE);
    expect(rows).toHaveLength(72 + 2); // lines 1..72 of the window: the first line is on the other side of the gap
  });

  it('does not include the first rendered line when the highlight is below the first gap', () => {
    // Compared with whitespace normalised: this fixture was pretty-printed when it was saved (CRLF,
    // wrapped comments), so the whitespace inside its lines is not the page's. Its STRUCTURE is.
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const { block, lines } = longCode();
    const inRun = blockElementText(block, lines[40]!).split('\n');
    expect(inRun.slice(1, -1).map(norm)).toEqual(lines.slice(1).map((l) => norm(l.textContent ?? '')));
  });

  it('is just that line plus a "continues below" marker for the line before the first gap', () => {
    const { block, lines } = longCode();
    const rows = blockElementText(block, lines[0]!).split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe(CODE_BELOW_NOT_ON_PAGE);
  });

  it('keeps the runs apart, with a marker between them, when it cannot tell which line the highlight is in', () => {
    const { block } = longCode();
    const rows = blockElementText(block).split('\n');
    expect(rows).toContain(CODE_BETWEEN_NOT_ON_PAGE);
    expect(rows[rows.length - 1]).toBe(CODE_BELOW_NOT_ON_PAGE);
    expect(rows).toHaveLength(73 + 2); // 73 lines, one marker between the runs, one at the end
  });
});

describe('the ChatGPT adapter with a windowed block in an answer', () => {
  let adapter: SiteAdapter;
  let chatCounter = 0;

  function setup(extraAnswerHtml: string): { chat: string; document: Document } {
    const chat = `windowed-chat-${++chatCounter}`;
    const html = `<div data-thread-find-target="conversation"><div><div data-turn-key="t1"><div data-content-search-turn-key="fallback-turn-0"><div data-talvt-turn-state="complete">
      <div data-user-message-bubble="true"><div class="whitespace-pre-wrap">write me the file</div></div>
      <div data-dil-message-id="m1"><p>Here is the file:</p>${extraAnswerHtml}</div>
    </div></div></div></div></div>`;
    const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const g = globalThis as unknown as Record<string, unknown>;
    g.document = document;
    g.location = { pathname: `/c/${chat}` };
    return { chat, document: document as unknown as Document };
  }

  beforeAll(async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const { document } = parseHTML('<!doctype html><html><body></body></html>');
    g.document = document;
    g.location = { pathname: '/' };
    adapter = (await import('./chatgpt')).chatgptAdapter;
  });

  const answer = (m: { element: HTMLElement }) => adapter.getMessageContent(m.element);

  it('sends the placeholder, not the rendered half, and tells the user in the popup note', () => {
    const { block } = longCode();
    setup(block.outerHTML);
    const [, assistant] = adapter.getAllMessages();
    expect(answer(assistant!)).toContain(PARTIAL_CODE_PLACEHOLDER);
    expect(answer(assistant!)).toContain('Here is the file:');
    const status = adapter.getOrderStatus!(assistant!.id);
    expect(status.note).toMatch(/only partly on the page/);
    expect(status.retrieval).toBe('ok'); // the numbering is fine; only this code is incomplete
  });

  it('also tells the user when a code block has not been drawn at all (no lines yet)', () => {
    setup('<div data-code-block="true"><div class="cm-editor"><div class="cm-content"></div></div></div>');
    const [, assistant] = adapter.getAllMessages();
    expect(answer(assistant!)).toContain(PARTIAL_CODE_PLACEHOLDER);
    expect(adapter.getOrderStatus!(assistant!.id).note).toMatch(/only partly on the page/);
  });

  it('says nothing about code when the answer has none, or only complete blocks', () => {
    setup('<p>no code here</p>');
    expect(adapter.getOrderStatus!(adapter.getAllMessages()[1]!.id).note).toBeNull();
    setup('<div data-code-block="true"><div class="cm-content"><div class="cm-line">x = 1</div></div></div>');
    const [, assistant] = adapter.getAllMessages();
    expect(answer(assistant!)).toContain('x = 1');
    expect(adapter.getOrderStatus!(assistant!.id).note).toBeNull();
  });

  it('keeps the message text (the change-detection key) identical while the window moves', () => {
    const first = longCode();
    setup(first.block.outerHTML);
    const before = adapter.getMessageText(adapter.getAllMessages()[1]!.element);

    const second = longCode();
    for (const line of second.lines.slice(10, 40)) line.remove();
    const { document } = setup(second.block.outerHTML);
    expect(document.querySelectorAll('.cm-line').length).toBeLessThan(73);
    expect(adapter.getMessageText(adapter.getAllMessages()[1]!.element)).toBe(before);
  });

  it('uses the run around the selection as the paragraph', () => {
    const { block, lines } = longCode();
    const { document } = setup(block.outerHTML);
    const line = document.querySelectorAll('.cm-line')[40]!;
    const range = { commonAncestorContainer: line, startContainer: line, toString: () => (lines[40]!.textContent ?? '') } as unknown as Range;
    const rows = adapter.getParagraphAround(range).split('\n');
    expect(rows[0]).toBe(CODE_ABOVE_NOT_ON_PAGE);
    expect(rows[rows.length - 1]).toBe(CODE_BELOW_NOT_ON_PAGE);
  });
});
