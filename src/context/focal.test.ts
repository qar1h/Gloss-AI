import { describe, expect, it } from 'vitest';
import { ORDER_OK, finalizeFocal } from './focal';
import { RECENT_ALWAYS_MAX_TOKENS } from './limits';
import type { PromptMessage, RawFocal } from './types';

const msg = (id: string, role: 'user' | 'assistant' = 'assistant'): PromptMessage => ({ id, role, text: `text ${id}` });
/** A message of exactly `tokens` estimated tokens (4 characters each). */
const big = (id: string, tokens: number, role: 'user' | 'assistant' = 'assistant'): PromptMessage => ({
  id,
  role,
  text: 'x'.repeat(tokens * 4),
});
const ids = (messages: PromptMessage[]) => messages.map((m) => m.id);

const raw: RawFocal = {
  highlight: 'h',
  paragraph: 'p',
  source: msg('12'),
  question: msg('11', 'user'),
  questionStatus: 'found',
  preceding: [msg('8'), msg('9', 'user'), msg('10'), msg('11', 'user')],
  precedingEndsAtGap: false,
};

describe('finalizeFocal: order status', () => {
  it('defaults to "order trusted" for sites that do not report one (Claude)', () => {
    expect(finalizeFocal(raw, 2).orderStatus).toEqual(ORDER_OK);
    expect(ORDER_OK).toEqual({ retrieval: 'ok', note: null, indexGeneration: null });
  });

  it('passes a site-reported status through untouched', () => {
    const status = { retrieval: 'disabled' as const, note: 'jumped here', indexGeneration: 'g1' };
    expect(finalizeFocal({ ...raw, orderStatus: status }, 2).orderStatus).toBe(status);
  });
});

describe('finalizeFocal', () => {
  it('takes the nearest N preceding messages and drops the question message from them', () => {
    expect(ids(finalizeFocal(raw, 2).recent)).toEqual(['10']); // nearest two are 10 and 11; 11 is the question
    expect(ids(finalizeFocal(raw, 3).recent)).toEqual(['9', '10']);
  });

  it('keeps the question in its own slot', () => {
    expect(finalizeFocal(raw, 2).question?.id).toBe('11');
  });

  it('count 0 means no recent messages (and must not mean "all of them")', () => {
    const focal = finalizeFocal(raw, 0);
    expect(focal.recent).toEqual([]);
    expect(focal.question?.id).toBe('11');
  });

  it('keeps both neighbours when the source is a user message with no question', () => {
    const userRaw: RawFocal = { ...raw, source: msg('12', 'user'), question: null, preceding: [msg('9'), msg('10', 'user'), msg('11')] };
    expect(ids(finalizeFocal(userRaw, 2).recent)).toEqual(['10', '11']);
  });

  it('demotes a recent message over the size limit: not in recent, and listed with its size', () => {
    const oversized = { ...raw, preceding: [big('9', RECENT_ALWAYS_MAX_TOKENS + 1), msg('10'), msg('11', 'user')] };
    const focal = finalizeFocal(oversized, 3);
    expect(ids(focal.recent)).toEqual(['10']);
    expect(focal.demotedRecent).toEqual([{ id: '9', estTokens: RECENT_ALWAYS_MAX_TOKENS + 1 }]);
  });

  it('keeps a recent message that is exactly at the limit', () => {
    const atLimit = { ...raw, preceding: [big('9', RECENT_ALWAYS_MAX_TOKENS), msg('11', 'user')] };
    const focal = finalizeFocal(atLimit, 2);
    expect(ids(focal.recent)).toEqual(['9']);
    expect(focal.demotedRecent).toEqual([]);
  });

  it('never demotes the question, however large: it keeps its own slot', () => {
    const bigQuestion = { ...raw, question: big('11', 5000, 'user'), preceding: [msg('10'), big('11', 5000, 'user')] };
    const focal = finalizeFocal(bigQuestion, 2);
    expect(focal.question?.id).toBe('11');
    expect(focal.demotedRecent).toEqual([]);
    expect(ids(focal.recent)).toEqual(['10']);
  });

  it('reports a shortfall when the page has a gap and fewer nearby messages were found than asked for', () => {
    const gappy: RawFocal = { ...raw, question: null, questionStatus: 'not-loaded', preceding: [], precedingEndsAtGap: true };
    const focal = finalizeFocal(gappy, 2);
    expect(focal.recentShortfall).toEqual({ wanted: 2, found: 0 });
    expect(focal.questionStatus).toBe('not-loaded');
    expect(focal.recent).toEqual([]);

    const partial: RawFocal = { ...raw, preceding: [msg('11', 'user')], precedingEndsAtGap: true };
    expect(finalizeFocal(partial, 3).recentShortfall).toEqual({ wanted: 3, found: 1 });
  });

  it('reports no shortfall when enough were found, even if the page also has a gap further back', () => {
    const enough: RawFocal = { ...raw, preceding: [msg('10'), msg('11', 'user')], precedingEndsAtGap: true };
    expect(finalizeFocal(enough, 2).recentShortfall).toBeNull();
  });

  it('reports no shortfall when the chat simply starts there (no gap), or when none were asked for', () => {
    const start: RawFocal = { ...raw, preceding: [msg('0', 'user')], precedingEndsAtGap: false };
    expect(finalizeFocal(start, 3).recentShortfall).toBeNull();
    expect(finalizeFocal({ ...raw, preceding: [], precedingEndsAtGap: true }, 0).recentShortfall).toBeNull();
  });

  it('passes the question status through unchanged', () => {
    expect(finalizeFocal({ ...raw, question: null, questionStatus: 'not-applicable' }, 2).questionStatus).toBe('not-applicable');
    expect(finalizeFocal(raw, 2).questionStatus).toBe('found');
  });

  it('copes with fewer preceding messages than asked for', () => {
    expect(ids(finalizeFocal({ ...raw, preceding: [msg('11', 'user')] }, 5).recent)).toEqual([]);
  });
});
