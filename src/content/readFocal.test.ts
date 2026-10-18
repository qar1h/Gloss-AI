// whyNotExplainable decides what the user is told when an Explain click finds nothing it can read.
// Silently doing nothing is the wrong behaviour: the click must always end in either an explanation
// or a plain sentence saying why not.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  message: null as unknown,
  reason: undefined as undefined | (() => string | null),
}));

vi.mock('@/sites', () => ({
  requireAdapter: () => ({
    getMessageForNode: () => state.message,
    ...(state.reason ? { explainBlockedReason: state.reason } : {}),
  }),
}));

import { whyNotExplainable } from './readFocal';

const range = { startContainer: {} } as unknown as Range;

beforeEach(() => {
  state.message = null;
  state.reason = undefined;
});

describe('whyNotExplainable', () => {
  it('uses the site\'s own reason when the selection is not in a message it can read', () => {
    state.reason = () => 'I can\'t read this part of the chat (an unfamiliar message layout).';
    expect(whyNotExplainable(range)).toBe('I can\'t read this part of the chat (an unfamiliar message layout).');
  });

  it('says nothing for a site that gives no reason (claude.ai keeps its behaviour)', () => {
    expect(whyNotExplainable(range)).toBeNull();
    state.reason = () => null;
    expect(whyNotExplainable(range)).toBeNull();
  });

  it('says so when the message was found but refused (its position looks wrong), instead of the site\'s reason', () => {
    state.message = { id: 'x', role: 'assistant', element: {} };
    state.reason = () => 'should not be used';
    expect(whyNotExplainable(range)).toMatch(/position on the page looks wrong/);
  });
});
