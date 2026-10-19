import { describe, expect, it } from 'vitest';
import { assemblePrompt } from './assemble';
import { MAX_SIMPLICITY_LEVEL, SIMPLICITY_LEVELS } from './levels';
import type { AssemblyOptions } from './limits';
import { joinSections, neutralizeTags } from './render';
import { promptAtLevel } from './simplicity';
import { makeChunk, makeFocal } from './test-helpers';
import { estimateTokens } from './tokens';
import type { AssembledPrompt, Candidate, FocalInput } from './types';

const OPTS: AssemblyOptions = { budgetTokens: 6000, thresholdTokens: 6000, maxChunks: 8 };

const TWO_RANKED: Candidate[] = [
  { chunk: makeChunk('7', 0, 'seven, about pooling'), fusedRank: 1, embeddingRank: 1, bm25Rank: 2 },
  { chunk: makeChunk('3', 0, 'three, about engines'), fusedRank: 2, embeddingRank: 3, bm25Rank: 1 },
];

function assembleWith(opts: AssemblyOptions, focal: FocalInput = makeFocal(), ranked: Candidate[] = TWO_RANKED): AssembledPrompt {
  return assemblePrompt(
    {
      focal,
      mode: 'retrieval',
      modeReason: 'test',
      others: ranked.map((c) => c.chunk).sort((a, b) => a.order - b.order),
      ranked,
      excludedMessageIds: [focal.source.id],
      excludedChunkCount: 0,
    },
    opts,
  );
}

const base = assembleWith(OPTS);

const LEVEL_0 =
  'Explain the highlighted part in simple, plain language. Use the surrounding conversation only where it actually helps understanding — do not just repeat it back. Keep the explanation focused on the highlighted part itself.';

describe('SIMPLICITY_LEVELS', () => {
  it("level 0 is today's instruction, word for word", () => {
    expect(SIMPLICITY_LEVELS[0]!.instruction).toBe(LEVEL_0);
    expect(base.prompt.endsWith(LEVEL_0)).toBe(true);
  });

  it('has four levels, the last labelled simplest', () => {
    // Changing the count is a deliberate edit (v9 plan, live check L5), so this test is edited with it.
    expect(SIMPLICITY_LEVELS).toHaveLength(4);
    expect(MAX_SIMPLICITY_LEVEL).toBe(3);
    expect(SIMPLICITY_LEVELS[MAX_SIMPLICITY_LEVEL]!.label).toBe('Explain · simplest');
  });

  it('every instruction is different', () => {
    expect(new Set(SIMPLICITY_LEVELS.map((l) => l.instruction)).size).toBe(SIMPLICITY_LEVELS.length);
  });

  it('no instruction contains one of our tag names', () => {
    for (const l of SIMPLICITY_LEVELS) expect(neutralizeTags(l.instruction)).toBe(l.instruction);
  });
});

describe('promptAtLevel', () => {
  it('level 0 returns the same prompt and report', () => {
    const r = promptAtLevel(base, 0);
    expect(r.prompt).toBe(base.prompt);
    expect(r.report).toEqual(base.report);
  });

  it('keeps every section before task identical at every level', () => {
    expect(base.report.excerptCount).toBe(2);
    for (let level = 1; level <= MAX_SIMPLICITY_LEVEL; level++) {
      const r = promptAtLevel(base, level);
      expect(r.sections.slice(0, -1)).toEqual(base.sections.slice(0, -1));
      expect(r.sections.at(-1)).toEqual({ name: 'task', text: SIMPLICITY_LEVELS[level]!.instruction });
      expect(r.prompt.startsWith(joinSections(base.sections.slice(0, -1)))).toBe(true);
      expect(r.report.includedChunkIds).toEqual(base.report.includedChunkIds);
      expect(r.report.candidates).toEqual(base.report.candidates);
    }
  });

  it('does not change the level-0 prompt it was given', () => {
    const before = structuredClone(base);
    promptAtLevel(base, 2);
    expect(base).toEqual(before);
  });

  it('recomputes the totals and records the level', () => {
    const r = promptAtLevel(base, 3);
    expect(r.report.simplicityLevel).toBe(3);
    expect(r.report.totalEstTokens).toBe(estimateTokens(r.prompt));
    expect(r.report.levelExtraTokens).toBe(r.report.totalEstTokens - base.report.totalEstTokens);
    expect(r.report.sections.find((s) => s.name === 'task')!.estTokens).toBe(
      estimateTokens(SIMPLICITY_LEVELS[3]!.instruction),
    );
  });

  it('warns when the level pushes the prompt over the budget, and only then', () => {
    // No excerpts, so the level-0 total is exact (no per-chunk upper-bound slack), and a budget one
    // token above it (equal would already trip the "always-include part is at or over the budget"
    // warning): level 0 fits, level 3 is over.
    const bare = assembleWith(OPTS, makeFocal(), []);
    const tight = assembleWith({ ...OPTS, budgetTokens: bare.report.totalEstTokens + 1 }, makeFocal(), []);
    expect(tight.report.totalEstTokens).toBeLessThanOrEqual(tight.report.budgetTokens);
    const r = promptAtLevel(tight, 3);
    expect(r.report.totalEstTokens).toBeGreaterThan(r.report.budgetTokens);
    expect(r.report.warnings.filter((w) => w.includes('instruction adds'))).toHaveLength(1);
    expect(r.report.warnings.at(-1)).toMatch(/level 3 instruction adds ≈\d+ est\. tokens/);
    expect(promptAtLevel(base, 3).report.warnings).toEqual(base.report.warnings); // 6000 budget: no warning
  });

  it('rejects a level that does not exist', () => {
    for (const bad of [-1, 4, 1.5, NaN]) expect(() => promptAtLevel(base, bad)).toThrow(RangeError);
  });

  it('only takes a level-0 base, so levels never stack', () => {
    expect(() => promptAtLevel(promptAtLevel(base, 1), 2)).toThrow(/level-0/);
  });

  it('behaves the same for a ChatGPT-shaped focal', () => {
    // Positions like 10001, an order note: nothing in promptAtLevel may depend on them.
    const gpt = assembleWith(
      OPTS,
      makeFocal({
        source: { id: '10001', role: 'assistant', text: 'Intro. Set pool_pre_ping to test connections before use. Outro.' },
        question: { id: '10000', role: 'user', text: 'How?' },
        recent: [],
        orderStatus: { retrieval: 'ok', note: 'code in this message is only partly on the page', indexGeneration: 'g1' },
      }),
    );
    const r = promptAtLevel(gpt, 2);
    expect(r.sections.slice(0, -1)).toEqual(gpt.sections.slice(0, -1));
    expect(r.report.orderNote).toBe(gpt.report.orderNote);
    expect(r.report.warnings).toEqual(gpt.report.warnings);
  });
});
