// The popup in a linkedom DOM. WXT's createShadowRootUi is an auto-import with no test build, so it
// is stubbed with a plain container; everything else is the real popup. linkedom has no layout and
// no KeyboardEvent: events are plain Events with `key` set, and the window size is set by hand.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import type { PopupHandle, PopupHandlers } from './popup';

let popup: PopupHandle;
let container: HTMLElement;
let doc: Document;
let win: Record<string, unknown>;

const rect = { top: 10, bottom: 20, left: 10, right: 50, width: 40, height: 10 } as DOMRect;

beforeAll(async () => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  win = window as unknown as Record<string, unknown>;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  doc = document as unknown as Document;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = document;
  container = document.createElement('div') as unknown as HTMLElement;
  document.body.append(container as never);
  g.createShadowRootUi = async (_ctx: unknown, options: { onMount: (c: HTMLElement, s: { host: HTMLElement }) => void }) => ({
    mount: () => options.onMount(container, { host: container }),
  });
  const { createPopup } = await import('./popup');
  popup = await createPopup({} as never);
});

let closed = 0;
let asked: string[] = [];
const handlers = (extra: Partial<PopupHandlers> = {}): PopupHandlers => ({
  onClose: () => void closed++,
  onSimpler: () => undefined,
  onAsk: (q) => void asked.push(q),
  ...extra,
});

beforeEach(() => {
  popup.close(); // the previous test's popup, before the counters are reset
  closed = 0;
  asked = [];
});

const thread = () => container.querySelector('.popup-thread') as HTMLElement;
const answers = () => [...container.querySelectorAll('.popup-answer')] as HTMLElement[];
const input = () => container.querySelector('.popup-input') as HTMLTextAreaElement;
const send = () => container.querySelector('.popup-send') as HTMLButtonElement;
const popupEl = () => container.querySelector('.popup') as HTMLElement;

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}): Event {
  const event = new (win.Event as typeof Event)(type, { bubbles: true, cancelable: true });
  Object.assign(event, props);
  target.dispatchEvent(event);
  return event;
}

/** An open popup whose first explanation has finished. */
function explained(text = 'The original explanation.'): void {
  popup.open(rect, handlers());
  popup.appendChunk(text);
  popup.markDone();
  popup.setComposer({ visible: true, canSend: true });
}

describe('popup — Simpler (v9 behaviour on the latest answer)', () => {
  it('a failed press restores the explanation and shows the error right above it, scrolled to it', () => {
    explained();
    thread().scrollTop = 300; // the reader had scrolled down a long explanation

    popup.beginRegenerate('Explain · simpler');
    popup.appendChunk('Half of a new');
    popup.failRegenerate('quota exceeded');

    const first = thread().firstElementChild as HTMLElement;
    expect(first.className).toBe('popup-error');
    expect(first.textContent).toBe("Couldn't simplify: quota exceeded");
    expect(first.nextElementSibling).toBe(answers()[0]);
    expect(thread().textContent).toContain('The original explanation.');
    expect(thread().textContent).not.toContain('Half of a new');
    expect(thread().scrollTop).toBe(0);
    expect(container.querySelector('.popup-header span')!.textContent).toBe('Explain');
  });

  it('a regenerate after a follow-up rewrites only the latest answer', () => {
    explained('EXPL');
    popup.beginFollowUp('why?');
    popup.appendChunk('because');
    popup.markDone();
    popup.beginRegenerate('Explain · simpler');
    popup.appendChunk('simpler because');
    popup.markDone();
    expect(answers().map((a) => a.textContent!.trim())).toEqual(['EXPL', 'simpler because']);
  });
});

describe('popup — follow-ups', () => {
  it('a follow-up is appended under the explanation, its question as plain text', () => {
    explained('EXPL');
    input().value = '<b>x</b>';
    popup.beginFollowUp('<b>x</b>');
    expect(input().value).toBe('');
    const question = container.querySelector('.popup-question') as HTMLElement;
    expect(question.textContent).toBe('<b>x</b>');
    expect(question.querySelector('b')).toBeNull();
    expect(answers()).toHaveLength(2);
    expect(answers()[1]!.textContent).toContain('Thinking…');
    popup.appendChunk('the answer');
    expect(answers()[0]!.textContent!.trim()).toBe('EXPL');
    expect(answers()[1]!.textContent!.trim()).toBe('the answer');
  });

  it('a failed follow-up is removed and its question comes back to the box', () => {
    explained('EXPL');
    popup.beginFollowUp('why?');
    popup.appendChunk('half');
    popup.failFollowUp('quota exceeded', 'why?');
    expect(container.querySelector('.popup-question')).toBeNull();
    expect(answers()).toHaveLength(1);
    expect(thread().lastElementChild!.textContent).toBe("Couldn't answer: quota exceeded");
    expect(input().value).toBe('why?');
    // The latest answer is the explanation again: a Simpler press now targets it.
    popup.beginRegenerate('Explain · simpler');
    popup.appendChunk('simpler');
    expect(answers()[0]!.textContent!.trim()).toBe('simpler');
  });

  it('the question is not put back over a new draft', () => {
    explained();
    popup.beginFollowUp('why?');
    input().value = 'a new draft';
    popup.failFollowUp('quota exceeded', 'why?');
    expect(input().value).toBe('a new draft');
  });

  it('a new follow-up clears an earlier error line', () => {
    explained();
    popup.beginFollowUp('q1');
    popup.failFollowUp('quota exceeded', 'q1');
    popup.beginFollowUp('q1');
    expect(container.querySelector('.popup-error')).toBeNull();
  });
});

describe('popup — closing', () => {
  it('an outside click closes a fresh popup but not one the user has typed in', () => {
    explained();
    fire(doc.body, 'pointerdown');
    expect(closed).toBe(1);

    closed = 0;
    explained();
    fire(input(), 'input');
    fire(doc.body, 'pointerdown');
    expect(closed).toBe(0);
    expect(popupEl().classList.contains('visible')).toBe(true);
    fire(doc, 'keydown', { key: 'Escape' });
    expect(closed).toBe(1);
  });

  it('a follow-up also makes it stick, and × still closes', () => {
    explained();
    popup.beginFollowUp('why?');
    fire(doc.body, 'pointerdown');
    expect(closed).toBe(0);
    (container.querySelector('.popup-close') as HTMLButtonElement).click();
    expect(closed).toBe(1);
  });

  it('Escape in the box closes the popup', () => {
    explained();
    fire(input(), 'keydown', { key: 'Escape' });
    expect(closed).toBe(1);
  });

  it('a new open is not sticky', () => {
    explained();
    fire(input(), 'input');
    explained();
    fire(doc.body, 'pointerdown');
    expect(closed).toBe(2); // the re-open closed the first, the click the second
  });
});

describe('popup — the text box', () => {
  it('keys and paste in the box do not reach the page', () => {
    explained();
    const seen: string[] = [];
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut']) {
      doc.addEventListener(type, () => seen.push(type));
      fire(input(), type, { key: 'a' });
    }
    expect(seen).toEqual([]);
  });

  it('Enter sends; Shift+Enter, composing and a disabled Send do not', () => {
    explained();
    input().value = 'why?';
    fire(input(), 'keydown', { key: 'Enter', shiftKey: true });
    fire(input(), 'keydown', { key: 'Enter', isComposing: true });
    expect(asked).toEqual([]);
    const enter = fire(input(), 'keydown', { key: 'Enter' });
    expect(asked).toEqual(['why?']);
    expect(enter.defaultPrevented).toBe(true);

    popup.setComposer({ visible: true, canSend: false });
    fire(input(), 'keydown', { key: 'Enter' });
    send().click();
    expect(asked).toEqual(['why?']);
    expect(send().disabled).toBe(true);
    expect(input().value).toBe('why?'); // the text stays until it is really sent
  });

  it('the Send button sends', () => {
    explained();
    input().value = 'how?';
    send().click();
    expect(asked).toEqual(['how?']);
  });

  it('has no text box without onAsk', () => {
    popup.open(rect, { onClose: () => undefined });
    popup.setComposer({ visible: true, canSend: true });
    expect((container.querySelector('.popup-composer') as HTMLElement).hidden).toBe(true);
  });
});

describe('popup — placement', () => {
  it('opening near the bottom of the screen places it above the highlight', () => {
    popup.open({ top: 740, bottom: 760, left: 50, right: 90, width: 40, height: 20 } as DOMRect, handlers());
    expect(popupEl().style.bottom).toBe('66px');
    expect(popupEl().style.top).toBe('');
    expect(popupEl().style.maxHeight).toBe('600px');
  });

  it('opening with room below places it below', () => {
    popup.open(rect, handlers());
    expect(popupEl().style.top).toBe('26px');
    expect(popupEl().style.bottom).toBe('');
  });
});
