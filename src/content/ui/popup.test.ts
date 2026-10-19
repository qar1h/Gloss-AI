// The popup's regenerate states, in a linkedom DOM. WXT's createShadowRootUi is an auto-import
// with no test build, so it is stubbed with a plain container; everything else is the real popup.

import { beforeAll, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import type { PopupHandle } from './popup';

let popup: PopupHandle;
let container: HTMLElement;

const rect = { top: 10, bottom: 20, left: 10, right: 50, width: 40, height: 10 } as DOMRect;

beforeAll(async () => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
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

const body = () => container.querySelector('.popup-body') as HTMLElement;
const scroller = () => container.querySelector('.popup') as HTMLElement;

describe('popup — a failed Simpler press', () => {
  it('restores the previous explanation and shows the error first, scrolled to the top', () => {
    popup.open(rect, () => undefined, () => undefined);
    popup.appendChunk('The original explanation.');
    popup.markDone();
    scroller().scrollTop = 300; // the reader had scrolled down a long explanation

    popup.beginRegenerate('Explain · simpler');
    popup.appendChunk('Half of a new');
    popup.failRegenerate('quota exceeded');

    const first = body().firstElementChild as HTMLElement;
    expect(first.className).toBe('popup-error');
    expect(first.textContent).toBe("Couldn't simplify: quota exceeded");
    expect(body().textContent).toContain('The original explanation.');
    expect(body().textContent).not.toContain('Half of a new');
    expect(scroller().scrollTop).toBe(0);
    expect(container.querySelector('.popup-header span')!.textContent).toBe('Explain');
  });
});
