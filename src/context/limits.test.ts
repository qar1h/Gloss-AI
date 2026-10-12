import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_RECENT_COUNT,
  DEFAULT_THRESHOLD_TOKENS,
  MAX_RECENT_COUNT,
  resolveAssemblyOptions,
  resolveRecentCount,
} from './limits';

describe('resolveAssemblyOptions', () => {
  it('falls back to the defaults for missing, zero, negative, NaN or non-number values', () => {
    for (const bad of [undefined, 0, -5, NaN, 'lots', null]) {
      expect(resolveAssemblyOptions({ budgetTokens: bad, thresholdTokens: bad, maxChunks: bad })).toEqual({
        budgetTokens: DEFAULT_BUDGET_TOKENS,
        thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
        maxChunks: DEFAULT_MAX_CHUNKS,
      });
    }
  });

  it('keeps good values, rounded to whole numbers', () => {
    expect(resolveAssemblyOptions({ budgetTokens: 8000.4, thresholdTokens: 3000, maxChunks: 3 })).toEqual({
      budgetTokens: 8000,
      thresholdTokens: 3000,
      maxChunks: 3,
    });
  });
});

describe('resolveRecentCount', () => {
  it('allows 0 (no recent messages)', () => expect(resolveRecentCount(0)).toBe(0));
  it('falls back to the default for garbage or negatives', () => {
    for (const bad of [undefined, -1, NaN, 'x', null]) expect(resolveRecentCount(bad)).toBe(DEFAULT_RECENT_COUNT);
  });
  it('rounds and caps at MAX_RECENT_COUNT', () => {
    expect(resolveRecentCount(3.6)).toBe(4);
    expect(resolveRecentCount(99)).toBe(MAX_RECENT_COUNT);
  });
});
