// A selection that touches our own popup or button must never bring up Explain. The shapes come
// from a Playwright probe of Chrome 155 (v10 plan, "Task 2 probe results"): a selection made
// inside the shadow root is reported collapsed at the host's parent, but a drag that starts in
// the page and ends in the popup is a real selection whose focus node is the host element itself.

import { beforeAll, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { getCurrentSelectionInfo, isInsideHosts } from './selection';

let document: Document;
let pageText: Node;
let host: HTMLElement;
let shadowText: Node;
let nestedShadowText: Node;
let otherShadowText: Node;

beforeAll(() => {
  ({ document } = parseHTML('<!doctype html><html><body><p id="page">Page text</p></body></html>') as unknown as {
    document: Document;
  });
  pageText = document.getElementById('page')!.firstChild!;

  host = document.createElement('highlight-explainer-popup');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const answer = document.createElement('p');
  answer.textContent = 'Popup answer';
  shadow.append(answer);
  shadowText = answer.firstChild!;

  const inner = document.createElement('inner-widget');
  shadow.append(inner);
  const innerShadow = inner.attachShadow({ mode: 'open' });
  const deep = document.createElement('span');
  deep.textContent = 'deep';
  innerShadow.append(deep);
  nestedShadowText = deep.firstChild!;

  const other = document.createElement('other-widget');
  document.body.append(other);
  const otherShadow = other.attachShadow({ mode: 'open' });
  const p = document.createElement('p');
  p.textContent = 'not ours';
  otherShadow.append(p);
  otherShadowText = p.firstChild!;
});

describe('isInsideHosts', () => {
  it('a text node inside the host shadow root is inside', () => {
    expect(isInsideHosts(shadowText, [host])).toBe(true);
  });
  it('the host itself is inside (a drag from the page into the popup ends on the host)', () => {
    expect(isInsideHosts(host, [host])).toBe(true);
  });
  it('a node in a shadow root nested inside the host is inside', () => {
    expect(isInsideHosts(nestedShadowText, [host])).toBe(true);
  });
  it('page text is not inside', () => {
    expect(isInsideHosts(pageText, [host])).toBe(false);
  });
  it('null is not inside', () => {
    expect(isInsideHosts(null, [host])).toBe(false);
  });
  it('a node in somebody else shadow root is not inside', () => {
    expect(isInsideHosts(otherShadowText, [host])).toBe(false);
  });
  it('the host parent is not inside (Chrome reports a selection in the popup as collapsed there)', () => {
    expect(isInsideHosts(document.body, [host])).toBe(false);
  });
});

describe('getCurrentSelectionInfo', () => {
  function stubSelection(anchorNode: Node, focusNode: Node, text: string): void {
    const range = {
      startContainer: anchorNode,
      endContainer: focusNode,
      getBoundingClientRect: () => ({ top: 0, bottom: 17, left: 0, right: 432, width: 432, height: 17 }),
    };
    (globalThis as unknown as { window: unknown }).window = {
      getSelection: () => ({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode,
        focusNode,
        toString: () => text,
        getRangeAt: () => range,
      }),
    };
  }

  it('a drag from the page into the popup (focus = host) is ignored', () => {
    stubSelection(pageText, host, 'Page text\n\n');
    expect(getCurrentSelectionInfo([host])).toBeNull();
  });

  it('a selection inside the popup text is ignored', () => {
    stubSelection(shadowText, shadowText, 'Popup answer');
    expect(getCurrentSelectionInfo([host])).toBeNull();
  });

  it('a selection in the page alone is still reported', () => {
    stubSelection(pageText, pageText, 'Page text');
    expect(getCurrentSelectionInfo([host])?.text).toBe('Page text');
  });

  it('with no hosts given, behaviour is unchanged', () => {
    stubSelection(pageText, host, 'Page text\n\n');
    expect(getCurrentSelectionInfo()?.text).toBe('Page text');
  });
});
