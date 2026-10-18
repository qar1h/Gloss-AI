// ChatGPT message DOM -> typed blocks. All ChatGPT-specific selectors for message CONTENT live
// here and in chatgpt.ts; every one was read off the captured fixtures (fixtures/chatgpt-*.html).
//
// What the fixtures showed, and what this file does about it:
//  - An answer is a flat list of components (paragraphs, titles, lists, tables, display math,
//    code blocks, "box" cards), not a tree of <p>/<pre> like Claude's.
//  - Code is `[data-code-block]`, in four shapes: CodeMirror lines (.cm-line), <pre>, a bare
//    <code> in [data-code-block-source], and a header (`[data-markdown-copy="exclude"]`: language
//    label, Run, Copy) that must never reach the text.
//  - KaTeX puts every formula in the DOM three times (MathML text, a TeX annotation, a visual
//    copy). Plain textContent would triple every formula, so a formula is read once, as TeX.
//  - A table's cells are <p>s; read one by one they lose their rows. Each row becomes one block.
//  - A user message is one `.whitespace-pre-wrap` div of plain text (no <p>), line breaks included.
//
// Two rules keep text from being lost or glued, in shapes the fixtures do not contain:
//  - Text that sits directly beside block children (a bare "Intro" before a <p>) is kept, as a
//    paragraph of its own; inline elements around it (<b>, <a>, a formula) are part of that text.
//  - A block boundary is a word boundary: "<li>one</li><li>two</li>" is "one two", never "onetwo".
//    (The fixtures were pretty-printed and so always had whitespace there; a live page need not.)
//
// Nothing here changes the page: text is read from clones.

import type { Block } from '../rag/types';

const CODE_BLOCK = '[data-code-block]';
const EXCLUDE = '[data-markdown-copy="exclude"]';
const TEX = 'annotation[encoding="application/x-tex"]';
const MATH_DISPLAY = '[data-d-component="math"]';
const STRUCTURAL = `p, h1, h2, h3, h4, h5, h6, ul, ol, table, pre, blockquote, ${CODE_BLOCK}, ${MATH_DISPLAY}`;
const NESTED = `ul, ol, table, pre, ${CODE_BLOCK}`;
const BLOCK_ANCESTORS = `${CODE_BLOCK}, pre, p, li, h1, h2, h3, h4, h5, h6, blockquote`;
const BLOCKISH = 'p, div, section, article, li, ul, ol, table, thead, tbody, tr, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, br';
const INLINE_TAGS = /^(span|a|strong|b|em|i|u|s|code|sub|sup|mark|small|abbr|kbd|del|ins|time|label|font)$/i;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A formula's TeX source from the annotation KaTeX keeps; the MathML text if there is none. */
function formulaOf(el: Element): string {
  const tex = el.querySelector(TEX)?.textContent;
  if (tex && tex.trim()) return collapse(tex);
  const mathml = el.querySelector('.katex-mathml')?.textContent;
  return collapse(mathml ?? el.textContent ?? '');
}

/**
 * The text of `el` with formulas written once as $TeX$, interface chrome removed, a space at every
 * block boundary, and anything matching `removeSelector` (nested blocks that get their own entry)
 * left out.
 */
function textOf(el: Element, removeSelector = ''): string {
  if (el.matches('.katex')) return `$${formulaOf(el)}$`;
  const clone = el.cloneNode(true) as Element;
  const doc = el.ownerDocument;

  // Separators first, while the blocks are still there; removal then leaves a space, not a join.
  for (const block of Array.from(clone.querySelectorAll(BLOCKISH))) {
    block.parentNode?.insertBefore(doc.createTextNode(' '), block);
    block.parentNode?.insertBefore(doc.createTextNode(' '), block.nextSibling);
  }
  clone.querySelectorAll(EXCLUDE).forEach((n) => n.remove());
  if (removeSelector) clone.querySelectorAll(removeSelector).forEach((n) => n.remove());
  clone.querySelectorAll('.katex').forEach((k) => k.replaceWith(doc.createTextNode(` $${formulaOf(k)}$ `)));

  // The spaces added around a formula are for the words next to it; punctuation right after it
  // should stay attached ("$x$," not "$x$ ,").
  return collapse(clone.textContent ?? '').replace(/(\$) ([,.;:!?)\]])/g, '$1$2');
}

function normalizeCode(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

/**
 * One CodeMirror line. A real line never contains a line break, so one inside it can only be
 * formatting: the captured fixtures were pretty-printed, which turned the spaces between tokens
 * into newlines plus indentation. Such a line is collapsed back to single spaces; a line without
 * one is kept verbatim, leading indentation included. (Whether the live DOM keeps indentation as
 * text in the line is checked live, not assumed from the fixtures.)
 */
function cmLineText(line: Element): string {
  const raw = (line.textContent ?? '').replace(/\r/g, '');
  return (raw.includes('\n') ? collapse(raw) : raw).replace(/\s+$/, '');
}

/** A code block's text, newlines and indentation intact, header excluded. */
function codeOf(block: Element): string {
  const lines = Array.from(block.querySelectorAll('.cm-content .cm-line'));
  if (lines.length > 0) return normalizeCode(lines.map(cmLineText).join('\n'));
  const pre = block.querySelector('pre');
  if (pre) return normalizeCode(pre.textContent ?? '');
  const code = block.querySelector('[data-code-block-source] code, code');
  return normalizeCode(code?.textContent ?? '');
}

function push(out: Block[], type: Block['type'], text: string): void {
  if (text) out.push({ type, text });
}

function visitList(list: Element, out: Block[]): void {
  for (const li of Array.from(list.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    push(out, 'list-item', textOf(li, NESTED));
    visitNested(li, out);
  }
}

/** Lists, tables and code blocks that sit inside another block, in order, through any wrappers. */
function visitNested(el: Element, out: Block[]): void {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (child.matches(EXCLUDE)) continue;
    if (tag === 'ul' || tag === 'ol') visitList(child, out);
    else if (child.matches(CODE_BLOCK)) push(out, 'code', codeOf(child));
    else if (tag === 'table') visitTable(child, out);
    else if (tag === 'pre') push(out, 'code', normalizeCode(child.textContent ?? ''));
    else if (child.querySelector(NESTED)) visitNested(child, out);
  }
}

function visitTable(table: Element, out: Block[]): void {
  for (const row of Array.from(table.querySelectorAll('tr'))) {
    if (row.closest('table') !== table) continue; // a nested table's rows are read when we reach it
    const cells = Array.from(row.children).filter((c) => /^(td|th)$/i.test(c.tagName));
    const values = cells.map((c) => textOf(c, 'table'));
    if (values.some(Boolean)) push(out, 'list-item', values.join(' | ').trim());
    for (const cell of cells) visitNested(cell, out);
  }
}

/** An element that is part of a line of text: no block inside it, not code. */
function isInline(el: Element): boolean {
  return (INLINE_TAGS.test(el.tagName) || el.matches('.katex')) && !el.querySelector(STRUCTURAL) && !el.matches(CODE_BLOCK);
}

/**
 * Reads an element's children in order. Text nodes and inline elements next to each other form a
 * paragraph; block children are read as blocks. Nothing is skipped: text beside block children is
 * kept (it used to be dropped, because only element children were visited).
 */
function visitChildren(el: Element, out: Block[]): void {
  let run = '';
  const flush = () => {
    push(out, 'paragraph', collapse(run));
    run = '';
  };
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      run += node.textContent ?? '';
    } else if (node.nodeType === 1) {
      const child = node as Element;
      if (child.matches(EXCLUDE)) continue;
      if (isInline(child)) {
        run += ` ${textOf(child)} `;
      } else {
        flush();
        visit(child, out);
      }
    }
  }
  flush();
}

function visit(el: Element, out: Block[]): void {
  if (el.matches(EXCLUDE)) return;
  const tag = el.tagName.toLowerCase();

  if (el.matches(CODE_BLOCK)) return push(out, 'code', codeOf(el));
  if (el.matches(MATH_DISPLAY)) return push(out, 'paragraph', `$$${formulaOf(el)}$$`);
  if (tag === 'p') return push(out, 'paragraph', textOf(el, NESTED));
  if (/^h[1-6]$/.test(tag)) return push(out, 'heading', textOf(el));
  if (tag === 'blockquote') {
    push(out, 'blockquote', textOf(el, NESTED));
    return visitNested(el, out); // lists and code inside a quote are blocks of their own
  }
  if (tag === 'ul' || tag === 'ol') return visitList(el, out);
  if (tag === 'table') return visitTable(el, out);
  if (tag === 'pre') return push(out, 'code', normalizeCode(el.textContent ?? ''));

  // A wrapper (a table component, a "box" card, ...). If anything inside is a block, read it child
  // by child. If it is only text and inline elements, its text is one paragraph.
  const holdsBlocks = el.querySelector(STRUCTURAL) !== null || Array.from(el.children).some((c) => !isInline(c));
  if (holdsBlocks) visitChildren(el, out);
  else push(out, 'paragraph', textOf(el));
}

/** An assistant answer's content root (the element carrying `data-dil-message-id`) as ordered blocks. */
export function assistantBlocks(root: Element): Block[] {
  const out: Block[] = [];
  if (root.matches(CODE_BLOCK)) {
    push(out, 'code', codeOf(root));
    return out;
  }
  visitChildren(root, out);
  return out;
}

/** A user message bubble (`data-user-message-bubble`) as paragraphs, line breaks kept. */
export function userBlocks(bubble: Element): Block[] {
  const wraps = Array.from(bubble.querySelectorAll('.whitespace-pre-wrap')).filter(
    (el) => !el.parentElement?.closest('.whitespace-pre-wrap'),
  );
  const out: Block[] = [];
  for (const wrap of wraps) {
    const text = (wrap.textContent ?? '').replace(/\r\n?/g, '\n').trim();
    for (const paragraph of text.split(/\n(?:[ \t]*\n)+/)) push(out, 'paragraph', paragraph.trim());
  }
  return out;
}

/** The nearest block element around a node (a selection's anchor), or null. */
export function blockElementFor(node: Node): Element | null {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return el?.closest(BLOCK_ANCESTORS) ?? null;
}

/** The text of one block element, as extraction above would give it (code keeps its newlines). */
export function blockElementText(el: Element): string {
  if (el.matches(CODE_BLOCK)) return codeOf(el);
  if (el.tagName.toLowerCase() === 'pre') return normalizeCode(el.textContent ?? '');
  if (el.tagName.toLowerCase() === 'li') return textOf(el, NESTED);
  return textOf(el, NESTED);
}
