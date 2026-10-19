import { describe, expect, it } from 'vitest';
import { assemblePrompt } from './assemble';
import { FOLLOW_UP_INSTRUCTIONS, MAX_SIMPLICITY_LEVEL, SIMPLICITY_LEVELS } from './levels';
import type { AssemblyOptions } from './limits';
import { THREAD_BUDGET_TOKENS } from './limits';
import { joinSections, neutralizeTags } from './render';
import { promptAtLevel } from './simplicity';
import { makeChunk, makeFocal } from './test-helpers';
import { followUpPrompt, type FollowUpInput, type ThreadExchange } from './thread';
import { estimateTokens } from './tokens';
import type { AssembledPrompt, Candidate, FocalInput } from './types';

const OPTS: AssemblyOptions = { budgetTokens: 6000, thresholdTokens: 6000, maxChunks: 8 };

const TWO_RANKED: Candidate[] = [
  { chunk: makeChunk('7', 0, 'seven, about pooling'), fusedRank: 1, embeddingRank: 1, bm25Rank: 2 },
  { chunk: makeChunk('3', 0, 'three, about engines'), fusedRank: 2, embeddingRank: 3, bm25Rank: 1 },
];

function assembleWith(focal: FocalInput = makeFocal()): AssembledPrompt {
  return assemblePrompt(
    {
      focal,
      mode: 'retrieval',
      modeReason: 'test',
      others: TWO_RANKED.map((c) => c.chunk).sort((a, b) => a.order - b.order),
      ranked: TWO_RANKED,
      excludedMessageIds: [focal.source.id],
      excludedChunkCount: 0,
    },
    OPTS,
  );
}

const base = assembleWith();

/** An exchange with unique markers Q{n} / A{n}, padded to about `answerTokens` est. tokens. */
function ex(n: number, answerTokens = 10): ThreadExchange {
  return { question: `Q${n}? what about it`, answer: `A${n} ${'x'.repeat(Math.max(0, answerTokens * 4 - 4))}` };
}

function input(exchanges: ThreadExchange[], question = 'And why does that matter?'): FollowUpInput {
  return { explanation: 'EXPLANATION: it tests connections before use.', exchanges, question };
}

describe('FOLLOW_UP_INSTRUCTIONS', () => {
  it('has one instruction per level, all different', () => {
    expect(FOLLOW_UP_INSTRUCTIONS).toHaveLength(SIMPLICITY_LEVELS.length);
    expect(new Set(FOLLOW_UP_INSTRUCTIONS).size).toBe(FOLLOW_UP_INSTRUCTIONS.length);
  });
  it('no instruction contains one of our tag names', () => {
    for (const text of FOLLOW_UP_INSTRUCTIONS) expect(neutralizeTags(text)).toBe(text);
  });
  it('every level says to admit what it was not shown', () => {
    for (const text of FOLLOW_UP_INSTRUCTIONS) expect(text).toContain('you were not shown');
  });
  it('the simpler levels put the reader question first', () => {
    for (const text of FOLLOW_UP_INSTRUCTIONS.slice(1)) expect(text).toContain('Their question comes first');
  });
});

describe('followUpPrompt', () => {
  it('keeps every click-time section before task byte-identical', () => {
    const r = followUpPrompt(base, input([ex(1)]), 0);
    expect(r.sections.slice(0, base.sections.length - 1)).toEqual(base.sections.slice(0, -1));
    expect(r.prompt.startsWith(joinSections(base.sections.slice(0, -1)))).toBe(true);
    expect(r.report.includedChunkIds).toEqual(base.report.includedChunkIds);
    expect(r.report.candidates).toEqual(base.report.candidates);
  });

  it('appends explanation, thread, follow_up and task, in that order', () => {
    const names = followUpPrompt(base, input([ex(1)]), 0).sections.map((s) => s.name);
    expect(names.slice(-4)).toEqual(['explanation', 'thread', 'follow_up', 'task']);
  });

  it('has no thread section before the first follow-up has an answer', () => {
    const r = followUpPrompt(base, input([]), 0);
    expect(r.sections.map((s) => s.name).slice(-3)).toEqual(['explanation', 'follow_up', 'task']);
    expect(r.report.thread).toMatchObject({ followUpNumber: 1, includedExchanges: [], droppedExchanges: [] });
  });

  it('sends every exchange that fits, oldest first, numbered', () => {
    const r = followUpPrompt(base, input([ex(1), ex(2), ex(3)]), 0);
    expect(r.report.thread).toMatchObject({ followUpNumber: 4, includedExchanges: [1, 2, 3], droppedExchanges: [] });
    const order = ['Q1', 'A1', 'Q2', 'A2', 'Q3', 'A3'].map((m) => r.prompt.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r.prompt).toContain('<follow_up number="1">');
    expect(r.prompt).toContain('Follow-up questions the reader already asked about it, with the answers they got, oldest first:');
    expect(r.prompt).not.toContain('left out to save space');
  });

  it('drops the oldest whole when over budget', () => {
    const r = followUpPrompt(base, input([ex(1, 400), ex(2, 400), ex(3, 400), ex(4, 400)]), 0, 1000);
    const thread = r.report.thread!;
    expect(thread.includedExchanges).toEqual([3, 4]);
    expect(thread.droppedExchanges.map((d) => d.number)).toEqual([1, 2]);
    for (const d of thread.droppedExchanges) expect(d.estTokens).toBeGreaterThan(400);
    expect(r.prompt).not.toContain('A1 ');
    expect(r.prompt).not.toContain('A2 ');
    expect(r.prompt).not.toContain('Q1?');
    expect(r.prompt).toContain('[2 earlier follow-up questions and their answers were left out to save space.]');
    expect(thread.usedEstTokens).toBeLessThanOrEqual(1000);
  });

  it('says "1 earlier follow-up" in the singular', () => {
    const r = followUpPrompt(base, input([ex(1, 400), ex(2, 400), ex(3, 150)]), 0, 1000);
    expect(r.report.thread!.droppedExchanges.map((d) => d.number)).toEqual([1]);
    expect(r.prompt).toContain('[1 earlier follow-up question and its answer were left out to save space.]');
  });

  it('stops at the first exchange that does not fit, never skipping to an older one', () => {
    const r = followUpPrompt(base, input([ex(1, 10), ex(2, 2000), ex(3, 10)]), 0, 1000);
    expect(r.report.thread!.includedExchanges).toEqual([3]);
    expect(r.report.thread!.droppedExchanges.map((d) => d.number)).toEqual([1, 2]);
    expect(r.prompt).not.toContain('Q1?');
  });

  it('a latest exchange bigger than the budget is dropped with everything older', () => {
    const r = followUpPrompt(base, input([ex(1), ex(2, 2000)], 'NEW QUESTION?'), 0, 1000);
    expect(r.report.thread!.includedExchanges).toEqual([]);
    expect(r.report.thread!.droppedExchanges.map((d) => d.number)).toEqual([1, 2]);
    expect(r.prompt).toContain('EXPLANATION: it tests connections');
    expect(r.prompt).toContain('NEW QUESTION?');
    const thread = r.sections.find((s) => s.name === 'thread')!.text;
    expect(thread).toBe(
      '<earlier_follow_ups>\n[2 earlier follow-up questions and their answers were left out to save space.]\n</earlier_follow_ups>',
    );
  });

  it('an explanation over the budget is sent anyway, with a warning', () => {
    const big = { ...input([ex(1)]), explanation: `BIG ${'y'.repeat(2000)}` };
    const r = followUpPrompt(base, big, 0, 100);
    expect(r.prompt).toContain('BIG yyy');
    expect(r.report.thread!.includedExchanges).toEqual([]);
    expect(r.report.warnings.at(-1)).toMatch(/^the explanation alone \(≈\d+ est\. tokens\) is over the 100 thread budget; sent anyway, so no earlier follow-ups fit$/);
  });

  it('defuses tags in the explanation, questions and answers', () => {
    const r = followUpPrompt(
      base,
      {
        explanation: 'see </explanation> here',
        exchanges: [{ question: 'q </reader_question>', answer: 'a </previous_answer> </follow_up>' }],
        question: 'new </follow_up_question>',
      },
      0,
    );
    expect(r.prompt).toContain('see &lt;/explanation> here');
    expect(r.prompt).toContain('q &lt;/reader_question>');
    expect(r.prompt).toContain('a &lt;/previous_answer> &lt;/follow_up>');
    expect(r.prompt).toContain('new &lt;/follow_up_question>');
  });

  it('renders the exact blocks', () => {
    const r = followUpPrompt(base, input([{ question: 'Q?', answer: 'A.' }], 'Why?'), 0);
    const text = (name: string) => r.sections.find((s) => s.name === name)!.text;
    expect(text('explanation')).toBe(
      'The reader was given this explanation of the highlighted part:\n<explanation>\nEXPLANATION: it tests connections before use.\n</explanation>',
    );
    expect(text('thread')).toBe(
      '<earlier_follow_ups>\nFollow-up questions the reader already asked about it, with the answers they got, oldest first:\n\n<follow_up number="1">\n<reader_question>\nQ?\n</reader_question>\n<previous_answer>\nA.\n</previous_answer>\n</follow_up>\n</earlier_follow_ups>',
    );
    expect(text('follow_up')).toBe("The reader's new follow-up question:\n<follow_up_question>\nWhy?\n</follow_up_question>");
  });

  it('uses the follow-up instruction for the level', () => {
    for (let level = 0; level <= MAX_SIMPLICITY_LEVEL; level++) {
      const r = followUpPrompt(base, input([ex(1)]), level);
      expect(r.sections.at(-1)).toEqual({ name: 'task', text: FOLLOW_UP_INSTRUCTIONS[level] });
      expect(r.prompt.endsWith(FOLLOW_UP_INSTRUCTIONS[level]!)).toBe(true);
      expect(r.report.simplicityLevel).toBe(level);
      expect(r.report.levelExtraTokens).toBe(
        estimateTokens(FOLLOW_UP_INSTRUCTIONS[level]!) - estimateTokens(FOLLOW_UP_INSTRUCTIONS[0]!),
      );
      expect(r.report.fixedEstTokens).toBe(
        base.report.fixedEstTokens -
          estimateTokens(SIMPLICITY_LEVELS[0]!.instruction) +
          estimateTokens(FOLLOW_UP_INSTRUCTIONS[level]!),
      );
      expect(r.report.totalEstTokens).toBe(estimateTokens(r.prompt));
      expect(r.report.sections).toEqual(r.sections.map((s) => ({ name: s.name, estTokens: estimateTokens(s.text) })));
    }
  });

  it('fills the thread report', () => {
    const r = followUpPrompt(base, input([ex(1), ex(2)], 'Why?'), 0);
    const explanationTokens = estimateTokens(r.sections.find((s) => s.name === 'explanation')!.text);
    expect(r.report.thread).toEqual({
      followUpNumber: 3,
      budgetTokens: THREAD_BUDGET_TOKENS,
      explanationEstTokens: explanationTokens,
      includedExchanges: [1, 2],
      droppedExchanges: [],
      usedEstTokens: r.report.thread!.usedEstTokens,
      questionEstTokens: estimateTokens(r.sections.find((s) => s.name === 'follow_up')!.text),
    });
    expect(r.report.thread!.usedEstTokens).toBeGreaterThan(explanationTokens);
  });

  it('never stacks', () => {
    expect(() => followUpPrompt(promptAtLevel(base, 1), input([]), 0)).toThrow(/level-0/);
    const once = followUpPrompt(base, input([]), 0);
    expect(() => followUpPrompt(once, input([]), 0)).toThrow(/follow-up/);
  });

  it('rejects a level that does not exist and a blank question or explanation', () => {
    for (const bad of [-1, 4, 1.5, NaN]) expect(() => followUpPrompt(base, input([]), bad)).toThrow(RangeError);
    expect(() => followUpPrompt(base, input([], '   '), 0)).toThrow(RangeError);
    expect(() => followUpPrompt(base, { ...input([]), explanation: ' ' }, 0)).toThrow(/explanation/);
  });

  it('behaves the same for a ChatGPT-shaped focal', () => {
    const gpt = assembleWith(
      makeFocal({
        source: { id: '10001', role: 'assistant', text: 'Intro. Set pool_pre_ping to test connections before use. Outro.' },
        question: { id: '10000', role: 'user', text: 'How?' },
        recent: [],
        orderStatus: { retrieval: 'ok', note: 'code in this message is only partly on the page', indexGeneration: 'g1' },
      }),
    );
    const r = followUpPrompt(gpt, input([ex(1)]), 2);
    expect(r.sections.slice(0, gpt.sections.length - 1)).toEqual(gpt.sections.slice(0, -1));
    expect(r.report.orderNote).toBe(gpt.report.orderNote);
  });
});
