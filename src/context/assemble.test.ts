import { describe, expect, it } from 'vitest';
import { assemblePrompt, chooseMode, type AssemblyInput } from './assemble';
import { PARAGRAPH_CEILING_TOKENS, type AssemblyOptions } from './limits';
import { makeChunk, makeFocal } from './test-helpers';
import type { Candidate, FocalInput } from './types';
import type { Chunk } from '../rag/types';
import { TRIM_MARKER } from './tokens';

const OPTS: AssemblyOptions = { budgetTokens: 6000, thresholdTokens: 6000, maxChunks: 8 };

const cand = (chunk: Chunk, fusedRank: number): Candidate => ({
  chunk,
  fusedRank,
  embeddingRank: fusedRank,
  bm25Rank: null,
});

function retrieve(
  ranked: Candidate[],
  opts: AssemblyOptions = OPTS,
  focal: FocalInput = makeFocal(),
  extra: Partial<AssemblyInput> = {},
) {
  return assemblePrompt(
    {
      focal,
      mode: 'retrieval',
      modeReason: 'test',
      others: ranked.map((c) => c.chunk).sort((a, b) => a.order - b.order),
      ranked,
      excludedMessageIds: ['12', '11', '10'],
      excludedChunkCount: 0,
      ...extra,
    },
    opts,
  );
}

const decisions = (r: { report: { candidates: { decision: string }[] } }) => r.report.candidates.map((c) => c.decision);

describe('assemblePrompt — retrieval mode', () => {
  it('puts excerpts in chat order, not rank order, and keeps the candidate table in rank order', () => {
    const r = retrieve([cand(makeChunk('7', 0, 'seven'), 1), cand(makeChunk('3', 0, 'three'), 2)]);
    expect(r.prompt.indexOf('three')).toBeLessThan(r.prompt.indexOf('seven'));
    expect(r.report.includedChunkIds).toEqual(['c:3:0', 'c:7:0']);
    expect(r.report.candidates.map((c) => c.fusedRank)).toEqual([1, 2]);
  });

  it('stops at the cap', () => {
    const ranked = [1, 2, 3, 4, 5].map((n) => cand(makeChunk(String(n), 0, `text ${n}`), n));
    const r = retrieve(ranked, { ...OPTS, maxChunks: 2 });
    expect(decisions(r)).toEqual(['included', 'included', 'cap', 'cap', 'cap']);
    expect(r.report.excerptCount).toBe(2);
  });

  it('skips a chunk whose text is already included', () => {
    const a = makeChunk('3', 0, 'same', { textHash: 'dup' });
    const b = makeChunk('4', 0, 'same', { textHash: 'dup' });
    expect(decisions(retrieve([cand(a, 1), cand(b, 2)]))).toEqual(['included', 'duplicate']);
  });

  it('skips a chunk that does not fit and keeps going, so one huge chunk cannot block smaller ones', () => {
    const { fixedTokens } = chooseMode(makeFocal(), [], OPTS);
    const opts = { ...OPTS, budgetTokens: fixedTokens + 200 };
    const r = retrieve([cand(makeChunk('3', 0, 'b'.repeat(4000)), 1), cand(makeChunk('4', 0, 'small one'), 2)], opts);
    expect(decisions(r)).toEqual(['too-big', 'included']);
    expect(r.report.totalEstTokens).toBeLessThanOrEqual(opts.budgetTokens);
  });

  it('never goes over the budget when the always-include part fits', () => {
    const { fixedTokens } = chooseMode(makeFocal(), [], OPTS);
    const opts = { ...OPTS, maxChunks: 50, budgetTokens: fixedTokens + 1000 };
    const ranked = Array.from({ length: 20 }, (_, i) => cand(makeChunk(String(i + 1), 0, 'w'.repeat(600)), i + 1));
    const r = retrieve(ranked, opts);
    expect(r.report.totalEstTokens).toBeLessThanOrEqual(opts.budgetTokens);
    expect(r.report.excerptCount).toBeGreaterThan(0);
    expect(r.report.excerptCount).toBeLessThan(20);
    for (const row of r.report.candidates) expect(row.runningTokens).toBeLessThanOrEqual(opts.budgetTokens);
  });

  it('adds no excerpts and warns when the always-include part alone is over the budget', () => {
    const r = retrieve([cand(makeChunk('3', 0, 'anything'), 1)], { ...OPTS, budgetTokens: 10 });
    expect(decisions(r)).toEqual(['no-room']);
    expect(r.report.excerptCount).toBe(0);
    expect(r.report.warnings.join(' ')).toContain('over the budget');
    expect(r.prompt).not.toContain('<excerpts>');
    expect(r.prompt).toContain('<highlight>\npool_pre_ping\n</highlight>');
  });

  it('also warns when the always-include part exactly uses the budget (every candidate is no-room)', () => {
    const { fixedTokens } = chooseMode(makeFocal(), [], OPTS);
    const r = retrieve([cand(makeChunk('3', 0, 'anything'), 1)], { ...OPTS, budgetTokens: fixedTokens });
    expect(decisions(r)).toEqual(['no-room']);
    expect(r.report.warnings.join(' ')).toContain('over the budget');
  });

  it('merges adjacent chunks of one message into a single excerpt', () => {
    const r = retrieve([cand(makeChunk('3', 0, 'first'), 1), cand(makeChunk('3', 1, 'second'), 2)]);
    expect(r.prompt.match(/<excerpt /g)).toHaveLength(1);
  });

  it('surfaces a retrieval note in the report', () => {
    const r = retrieve([], OPTS, makeFocal(), { retrievalNote: 'query embedding unavailable (timed out)' });
    expect(r.report.retrievalNote).toBe('query embedding unavailable (timed out)');
    expect(r.report.orderNote).toBeNull(); // a normal site says nothing about order
  });

  it('carries a site order note into the report and warns about it, without changing the prompt', () => {
    const plain = retrieve([], OPTS, makeFocal());
    const status = { retrieval: 'ok' as const, note: 'chat order changed unexpectedly earlier on this page', indexGeneration: 'g2' };
    const noted = retrieve([], OPTS, makeFocal({ orderStatus: status }));
    expect(noted.report.orderNote).toBe(status.note);
    expect(noted.report.warnings.some((w) => w.includes(status.note))).toBe(true);
    expect(noted.prompt).toBe(plain.prompt); // the note is for the user; Gemini's prompt is untouched
  });

  it('records what was excluded before ranking', () => {
    const r = retrieve([], OPTS, makeFocal(), { excludedChunkCount: 7 });
    expect(r.report.excludedMessageIds).toEqual(['12', '11', '10']);
    expect(r.report.excludedChunkCount).toBe(7);
  });
});

describe('assemblePrompt — full mode', () => {
  it('includes every other chunk in chat order, with no ranking involved', () => {
    const others = [makeChunk('3', 0, 'three'), makeChunk('4', 0, 'four'), makeChunk('7', 0, 'seven')];
    const r = assemblePrompt(
      { focal: makeFocal(), mode: 'full', modeReason: 'test', others, ranked: null, excludedMessageIds: [], excludedChunkCount: 0 },
      OPTS,
    );
    expect(r.report.includedChunkIds).toEqual(['c:3:0', 'c:4:0', 'c:7:0']);
    expect(decisions(r)).toEqual(['included', 'included', 'included']);
    expect(r.report.candidates.map((c) => c.fusedRank)).toEqual([null, null, null]);
    expect(r.prompt.indexOf('three')).toBeLessThan(r.prompt.indexOf('seven'));
  });

  it('builds a valid prompt with no excerpts when nothing else is indexed', () => {
    const r = assemblePrompt(
      { focal: makeFocal(), mode: 'full', modeReason: 'test', others: [], ranked: null, excludedMessageIds: [], excludedChunkCount: 0 },
      OPTS,
    );
    expect(r.report.excerptCount).toBe(0);
    expect(r.prompt).not.toContain('<excerpts>');
    expect(r.prompt).toContain('<message_being_explained');
  });
});

describe('chooseMode', () => {
  const others = [makeChunk('3', 0, 't'.repeat(400))];

  it('picks full when everything fits the threshold, retrieval when it does not; equal counts as fitting', () => {
    const base = chooseMode(makeFocal(), others, OPTS);
    expect(base.mode).toBe('full');
    expect(chooseMode(makeFocal(), others, { ...OPTS, thresholdTokens: base.allTokens }).mode).toBe('full');
    expect(chooseMode(makeFocal(), others, { ...OPTS, thresholdTokens: base.allTokens - 1 }).mode).toBe('retrieval');
  });

  it('picks full when there is nothing else to retrieve', () => {
    expect(chooseMode(makeFocal(), [], { ...OPTS, thresholdTokens: 1 }).mode).toBe('full');
  });

  it('honours a forced mode and says so', () => {
    const forced = chooseMode(makeFocal(), others, OPTS, 'retrieval');
    expect(forced.mode).toBe('retrieval');
    expect(forced.reason).toContain('forced');
  });
});

describe('per-item ceilings', () => {
  it('windows a huge source message around the paragraph and reports the trim', () => {
    const paragraph = 'Set pool_pre_ping to test connections before use.';
    const text = 'start. ' + 'w'.repeat(30000) + ` ${paragraph} ` + 'w'.repeat(30000);
    const focal = makeFocal({ source: { id: '12', role: 'assistant', text }, paragraph });
    const r = retrieve([], OPTS, focal);
    expect(r.report.trimmed).toContain('message_being_explained');
    expect(r.prompt).toContain(paragraph);
    expect(r.prompt).toContain(TRIM_MARKER);
  });

  it('trims a huge question and says so', () => {
    const focal = makeFocal({ question: { id: '11', role: 'user', text: 'q'.repeat(40000) } });
    const r = retrieve([], OPTS, focal);
    expect(r.report.trimmed).toContain('user_question');
  });
});

describe('paragraph ceiling', () => {
  it('windows a huge code-block paragraph around the highlight, keeps the highlight whole, and says so', () => {
    const paragraph = Array.from({ length: 400 }, (_, i) => `    value_${i} = compute(${i})`).join('\n');
    const highlight = 'value_200 = compute(200)';
    const focal = makeFocal({ highlight, paragraph, source: { id: '12', role: 'assistant', text: paragraph } });
    const r = retrieve([], OPTS, focal);

    const section = r.report.sections.find((s) => s.name === 'paragraph')!;
    expect(section.estTokens).toBeLessThanOrEqual(PARAGRAPH_CEILING_TOKENS + 30); // + the label and tags
    expect(r.report.trimmed).toContain('paragraph');
    const paragraphText = r.prompt.slice(r.prompt.indexOf('<paragraph>'), r.prompt.indexOf('</paragraph>'));
    expect(paragraphText).toContain(highlight);
    expect(paragraphText).toContain(TRIM_MARKER);
    expect(r.prompt).toContain(`<highlight>\n${highlight}\n</highlight>`);
  });

  it('leaves a paragraph that already fits alone', () => {
    const r = retrieve([], OPTS, makeFocal());
    expect(r.report.trimmed).not.toContain('paragraph');
    expect(r.prompt).toContain('<paragraph>\nSet pool_pre_ping to test connections before use.\n</paragraph>');
  });

  it('still centres on the highlight when its whitespace differs from the paragraph (a selection spanning a line break)', () => {
    const paragraph = 'filler '.repeat(800) + 'the quick brown fox jumps' + ' filler'.repeat(800);
    const focal = makeFocal({ highlight: 'quick brown\nfox', paragraph, source: { id: '12', role: 'assistant', text: 'short' } });
    const r = retrieve([], OPTS, focal);
    const paragraphText = r.prompt.slice(r.prompt.indexOf('<paragraph>'), r.prompt.indexOf('</paragraph>'));
    expect(paragraphText).toContain('quick brown fox');
  });

  it('still anchors the source-message window on the ORIGINAL paragraph, not the trimmed one', () => {
    const paragraph = Array.from({ length: 400 }, (_, i) => `    value_${i} = compute(${i})`).join('\n');
    const text = 'start. ' + 'w'.repeat(30000) + `\n${paragraph}\n` + 'w'.repeat(30000);
    const focal = makeFocal({ highlight: 'value_200 = compute(200)', paragraph, source: { id: '12', role: 'assistant', text } });
    const r = retrieve([], OPTS, focal);
    expect(r.report.trimmed).toEqual(expect.arrayContaining(['message_being_explained', 'paragraph']));
    const messageText = r.prompt.slice(r.prompt.indexOf('<message_being_explained'), r.prompt.indexOf('</message_being_explained>'));
    expect(messageText).toContain('value_200 = compute(200)');
  });
});

describe('demoted recent messages and empty questions', () => {
  it('passes demoted recent messages through to the report', () => {
    const r = retrieve([], OPTS, makeFocal({ demotedRecent: [{ id: '9', estTokens: 1500 }] }));
    expect(r.report.demotedRecent).toEqual([{ id: '9', estTokens: 1500 }]);
  });

  it('names each cause of a missing question separately, in the report state and in a warning', () => {
    const notLoaded = retrieve([], OPTS, makeFocal({ question: null, questionStatus: 'not-loaded' }));
    expect(notLoaded.report.questionState).toBe('not-loaded');
    expect(notLoaded.report.warnings.join(' ')).toContain("isn't loaded");
    expect(notLoaded.report.warnings.join(' ')).toContain('before message 12');

    const empty = retrieve([], OPTS, makeFocal({ question: { id: '11', role: 'user', text: '' } }));
    expect(empty.report.questionState).toBe('empty');
    expect(empty.report.warnings.join(' ')).toContain('no readable text');
    expect(empty.report.warnings.join(' ')).not.toContain("isn't loaded");

    expect(retrieve([], OPTS, makeFocal()).report.questionState).toBe('found');
    expect(retrieve([], OPTS, makeFocal({ question: null, questionStatus: 'not-applicable' })).report.questionState).toBe('not-applicable');
    expect(retrieve([], OPTS, makeFocal({ question: null, questionStatus: 'none' })).report.questionState).toBe('none');
    // "not applicable" and "none" are normal and must not warn.
    expect(retrieve([], OPTS, makeFocal({ question: null, questionStatus: 'not-applicable' })).report.warnings.join(' ')).not.toContain('question');
  });

  it('says how many recent messages were actually found when the page has a gap', () => {
    const r = retrieve([], OPTS, makeFocal({ recentShortfall: { wanted: 2, found: 0 } }));
    expect(r.report.recentShortfall).toEqual({ wanted: 2, found: 0 });
    expect(r.report.warnings.join(' ')).toContain('wanted 2, found 0');
  });

  it('warns when the question message has no readable text', () => {
    const r = retrieve([], OPTS, makeFocal({ question: { id: '11', role: 'user', text: '' } }));
    expect(r.report.warnings.join(' ')).toContain('(message 11) has no readable text');
  });
});

describe('report', () => {
  it('has a per-section token table that adds up close to the total', () => {
    const r = retrieve([cand(makeChunk('3', 0, 'three'), 1)]);
    const names = r.report.sections.map((s) => s.name);
    expect(names).toEqual(['instructions', 'excerpts', 'recent', 'message', 'question', 'highlight', 'paragraph', 'task']);
    const sum = r.report.sections.reduce((n, s) => n + s.estTokens, 0);
    expect(Math.abs(sum - r.report.totalEstTokens)).toBeLessThanOrEqual(names.length);
  });
});
