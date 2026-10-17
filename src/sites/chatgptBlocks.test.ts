// Block extraction for ChatGPT messages, checked against the real captured fixtures
// (fixtures/chatgpt-*.html) and against small hand-built DOMs for the shapes the fixtures
// do not contain. Selectors are only ever written from the fixtures.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { assistantBlocks, blockElementText, userBlocks } from './chatgptBlocks';
import type { Block } from '../rag/types';

function parse(html: string): Document {
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document;
}
function fixtureDoc(name: string): Document {
  return parse(readFileSync(resolve(__dirname, '../../fixtures', name), 'utf8'));
}
function frag(html: string): Element {
  return parse(`<div id="root">${html}</div>`).getElementById('root')!;
}
const types = (blocks: Block[]) => blocks.map((b) => b.type);
const texts = (blocks: Block[]) => blocks.map((b) => b.text);
const joined = (blocks: Block[]) => texts(blocks).join('\n\n');
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('the real ChatGPT conversation fixture: assistant answers', () => {
  const doc = fixtureDoc('chatgpt-conversation.html');
  const roots = Array.from(doc.querySelectorAll('[data-dil-message-id]'));
  const [palindrome, languages, natural] = roots.map((r) => assistantBlocks(r));

  it('finds the three answers', () => {
    expect(roots).toHaveLength(3);
  });

  it('keeps every code block whole, once, with its newlines, whichever of the four shapes it has', () => {
    // answer 1: a CodeMirror block (13 lines) and a bare <code> "Plain text" block
    const code0 = palindrome!.filter((b) => b.type === 'code');
    expect(code0).toHaveLength(2);
    expect(code0[0]!.text.startsWith('num = 121')).toBe(true);
    expect(code0[0]!.text.split('\n')).toHaveLength(13);
    expect(code0[1]!.text).toBe('Palindrome');

    // answer 2: Python (CodeMirror) plus C, Java and C++ (<pre>)
    const code1 = languages!.filter((b) => b.type === 'code');
    expect(code1).toHaveLength(4);
    expect(code1[1]!.text.startsWith('#include <stdio.h>')).toBe(true);
    expect(code1[1]!.text.split('\n').length).toBeGreaterThan(5);
    expect(code1[2]!.text.startsWith('class Main')).toBe(true);
    expect(code1[3]!.text.startsWith('#include <iostream>')).toBe(true);
    expect(count(joined(languages!), '#include <stdio.h>')).toBe(1);
  });

  it('never carries the code header (language label, Run, Copy, word wrap) into any block', () => {
    for (const blocks of [palindrome!, languages!, natural!]) {
      const all = joined(blocks);
      expect(all).not.toContain('Enable word wrap');
      expect(all).not.toContain('Copy code');
      expect(all).not.toMatch(/\bPython\s+Run\b/);
    }
    // the label is not glued to the first line of code (the v5 "pythonfrom" bug)
    expect(palindrome!.find((b) => b.type === 'code')!.text.startsWith('num = 121')).toBe(true);
  });

  it('turns a table into one list-item per row, cells joined by " | ", header first', () => {
    const header = palindrome!.find((b) => b.text === 'Number | Reversed | Palindrome?');
    expect(header?.type).toBe('list-item');
    expect(palindrome!.some((b) => b.type === 'list-item' && /^121 \| 121 \|/.test(b.text))).toBe(true);
    // not shredded into one-word paragraphs
    expect(palindrome!.some((b) => b.type === 'paragraph' && b.text === 'Reversed')).toBe(false);
    expect(languages!.some((b) => /^Feature \| Python \| C \| Java \| C\+\+$/.test(b.text))).toBe(true);
  });

  it('writes a formula once, as TeX, never as the three renderings KaTeX puts in the DOM', () => {
    const display = natural!.filter((b) => b.text === '$$1, 2, 3, 4, 5, 6, 7, 8, \\ldots$$');
    expect(display).toHaveLength(1);
    expect(display[0]!.type).toBe('paragraph');
    const all = joined(natural!);
    expect(all).toContain('Convention 1: Natural numbers start from 1: $1,2,3,4,\\ldots$');
    expect(all).not.toContain('1 , 2 , 3'); // the MathML text rendering
    expect(all).not.toContain('1,2,3,4,…'); // the visual rendering
  });

  it('keeps headings, paragraphs and nested list items as separate typed blocks, in order', () => {
    expect(palindrome![0]).toEqual({ type: 'paragraph', text: expect.stringMatching(/^A palindrome number/) });
    expect(palindrome![1]).toEqual({ type: 'heading', text: '1. Examples' });
    expect(types(natural!).filter((t) => t === 'heading')).toHaveLength(4);
    expect(natural!.filter((b) => b.type === 'list-item').length).toBeGreaterThan(8);
  });

  it('loses no prose: every word of the visible answer ends up in some block', () => {
    // The chars-captured check that exposed the Claude logic on this DOM (80%/94%/90%).
    for (const [root, blocks] of roots.map((r, i) => [r, [palindrome, languages, natural][i]!] as const)) {
      const clone = root.cloneNode(true) as Element;
      clone.querySelectorAll('.katex-html, [data-markdown-copy="exclude"], svg, button').forEach((n) => n.remove());
      clone.querySelectorAll('[data-code-block]').forEach((n) => n.remove());
      const words = (clone.textContent ?? '').split(/\s+/).filter((w) => /^[A-Za-z]{5,}$/.test(w));
      const text = joined(blocks);
      const missing = words.filter((w) => !text.includes(w));
      expect(missing).toEqual([]);
    }
  });
});

describe('the real ChatGPT conversation fixture: user messages', () => {
  const doc = fixtureDoc('chatgpt-conversation.html');
  const bubbles = Array.from(doc.querySelectorAll('[data-user-message-bubble]'));

  it('reads the plain text, without capture whitespace or carriage returns', () => {
    expect(bubbles).toHaveLength(3);
    const first = userBlocks(bubbles[0]!);
    expect(first).toEqual([{ type: 'paragraph', text: 'Explain palindrome number' }]);
    expect(userBlocks(bubbles[1]!)[0]!.text.startsWith('Tell which language is')).toBe(true);
    for (const b of bubbles) for (const block of userBlocks(b)) expect(block.text).not.toMatch(/\r|^\s|\s$/);
  });

  it('reads the single-message user fixture too', () => {
    const one = fixtureDoc('chatgpt-user-message.html').querySelector('[data-user-message-bubble]')!;
    expect(userBlocks(one)).toEqual([{ type: 'paragraph', text: 'Explain natural number no code right now' }]);
  });
});

describe('the other single-message fixtures', () => {
  it('reads an answer fixture that was captured without its turn wrapper (stream-word spans and all)', () => {
    const root = fixtureDoc('chatgpt-message.html').querySelector('[data-dil-message-id]')!;
    const blocks = assistantBlocks(root);
    expect(blocks[0]).toEqual({ type: 'paragraph', text: expect.stringMatching(/^A natural number is a number we use for counting things\.$/) });
    expect(blocks.some((b) => b.type === 'heading')).toBe(true);
  });

  it('reads a lone code block fixture', () => {
    const code = fixtureDoc('chatgpt-code-message.html').querySelector('[data-code-block]')!;
    const blocks = assistantBlocks(code.parentElement!);
    expect(types(blocks)).toEqual(['code']);
    expect(blocks[0]!.text.split('\n')).toHaveLength(13);
  });
});

describe('assistantBlocks: shapes the fixtures do not contain', () => {
  const katex = (tex: string, visible: string) =>
    `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>${visible}</mi></mrow><annotation encoding="application/x-tex"> ${tex} </annotation></semantics></math></span><span class="katex-html" aria-hidden="true">${visible}${visible}</span></span>`;

  it('writes inline math into its paragraph as $TeX$', () => {
    const blocks = assistantBlocks(frag(`<p>Let ${katex('x^2', 'x2')} be small.</p>`));
    expect(blocks).toEqual([{ type: 'paragraph', text: 'Let $x^2$ be small.' }]);
  });

  it('falls back to the MathML text when a formula has no TeX annotation', () => {
    const blocks = assistantBlocks(frag(`<p>See <span class="katex"><span class="katex-mathml"><math><mi>y</mi></math></span><span class="katex-html" aria-hidden="true">yy</span></span> here</p>`));
    expect(blocks[0]!.text).toBe('See $y$ here'); // still marked as a formula
  });

  it('does not mutate the page it reads', () => {
    const root = frag(`<p>Let ${katex('x^2', 'x2')} be.</p>`);
    const before = root.innerHTML;
    assistantBlocks(root);
    expect(root.innerHTML).toBe(before);
  });

  it('splits nested lists into their own items and keeps parent text out of the child', () => {
    const blocks = assistantBlocks(frag(`<ul><li><div><p>Parent</p></div><ul><li><div><p>Child one</p></div></li><li><div><p>Child two</p></div></li></ul></li><li><div><p>Sibling</p></div></li></ul>`));
    expect(blocks).toEqual([
      { type: 'list-item', text: 'Parent' },
      { type: 'list-item', text: 'Child one' },
      { type: 'list-item', text: 'Child two' },
      { type: 'list-item', text: 'Sibling' },
    ]);
  });

  it('keeps a code block inside a list item as its own code block, not as text of the item', () => {
    const blocks = assistantBlocks(frag(`<ol><li><p>Run this:</p><div data-code-block="true"><div data-markdown-copy="exclude">Python</div><div data-code-block-source="true"><code>x = 1\ny = 2</code></div></div></li></ol>`));
    expect(blocks).toEqual([
      { type: 'list-item', text: 'Run this:' },
      { type: 'code', text: 'x = 1\ny = 2' },
    ]);
  });

  it('keeps the leading indentation of a CodeMirror line, and treats a line break inside a line as formatting', () => {
    const messy = "\r\n      print(\r\n      y)\r\n   ";
    const html = `<div data-code-block="true"><div class="cm-content"><div class="cm-line">while x:</div><div class="cm-line">    y = 1</div><div class="cm-line">${messy}</div></div></div>`;
    const blocks = assistantBlocks(frag(html));
    expect(blocks).toEqual([{ type: 'code', text: 'while x:\n    y = 1\nprint( y)' }]);
  });

  it('reads CodeMirror lines in order, keeps blank lines inside, trims blank lines at the ends', () => {
    const lines = ['', 'def f():', '', '    return 1', '', ''].map((l) => `<div class="cm-line">${l}</div>`).join('');
    const blocks = assistantBlocks(frag(`<div data-code-block="true"><div data-markdown-copy="exclude">Python</div><div class="cm-editor"><div class="cm-content">${lines}</div></div></div>`));
    expect(blocks).toEqual([{ type: 'code', text: 'def f():\n\n    return 1' }]);
  });

  it('turns a <pre> outside a code block into code, and a blockquote into a blockquote', () => {
    const blocks = assistantBlocks(frag(`<pre>a\n  b</pre><blockquote><p>quoted words</p></blockquote>`));
    expect(blocks).toEqual([
      { type: 'code', text: 'a\n  b' },
      { type: 'blockquote', text: 'quoted words' },
    ]);
  });

  it('does not lose text that sits in a plain div with no paragraph around it', () => {
    const blocks = assistantBlocks(frag(`<div data-d-component="box"><div>Step 1</div><div><span>digit</span> = 1</div></div>`));
    expect(texts(blocks)).toEqual(['Step 1', 'digit = 1']);
  });

  it('ignores empty elements and interface chrome', () => {
    const blocks = assistantBlocks(frag(`<p></p><p>   </p><div data-markdown-copy="exclude"><p>Copy</p></div><p>Real</p>`));
    expect(blocks).toEqual([{ type: 'paragraph', text: 'Real' }]);
  });

  it('reads a table that has no header section', () => {
    const blocks = assistantBlocks(frag(`<div data-d-component="table"><table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td><td><p></p></td></tr></tbody></table></div>`));
    expect(blocks).toEqual([
      { type: 'list-item', text: 'a | b' },
      { type: 'list-item', text: 'c |' },
    ]);
  });
});

describe('userBlocks: shapes the fixtures do not contain', () => {
  const bubble = (inner: string) => frag(`<div data-user-message-bubble="true"><div class="whitespace-pre-wrap">${inner}</div></div>`).firstElementChild!;

  it('splits on blank lines into paragraphs and keeps single line breaks (pasted code, lists)', () => {
    const blocks = userBlocks(bubble('first line\r\nsecond line\r\n\r\n\r\nnext   paragraph  '));
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'first line\nsecond line' },
      { type: 'paragraph', text: 'next   paragraph' },
    ]);
  });

  it('gives no blocks for an attachment-only message', () => {
    expect(userBlocks(frag(`<div data-user-message-bubble="true"><img alt="file.png" src="x"></div>`).firstElementChild!)).toEqual([]);
    expect(userBlocks(bubble('  \r\n  '))).toEqual([]);
  });
});

describe('blockElementText', () => {
  it('gives the text of the block a highlight sits in, with formulas as TeX and code with its newlines', () => {
    const root = frag(`<p id="p">Use <span class="katex"><span class="katex-mathml"><math><annotation encoding="application/x-tex">a+b</annotation></math></span><span class="katex-html" aria-hidden="true">a+b a+b</span></span> now</p><pre id="c">x\n y</pre><ul><li id="l"><p>own</p><ul><li><p>nested</p></li></ul></li></ul>`);
    expect(blockElementText(root.querySelector('#p')!)).toBe('Use $a+b$ now');
    expect(blockElementText(root.querySelector('#c')!)).toBe('x\n y');
    expect(blockElementText(root.querySelector('#l')!)).toBe('own'); // not the nested item's text
  });
});
