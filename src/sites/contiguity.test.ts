import { describe, expect, it } from 'vitest';
import { contiguousPrecedingRun } from './contiguity';

describe('contiguousPrecedingRun', () => {
  it('counts rows that are each exactly one before the row after them', () => {
    // 12 is the source row; 11, 10, 9 are before it. Ran out of rows at 9 (> 0): older rows exist but aren't loaded.
    expect(contiguousPrecedingRun([12, 11, 10, 9])).toEqual({ length: 3, endsAtGap: true });
  });

  it('stops at a break straight away, which is exactly the 217 <- 126 case seen live', () => {
    expect(contiguousPrecedingRun([217, 126, 125, 124])).toEqual({ length: 0, endsAtGap: true });
  });

  it('stops part-way at the first break, ignoring contiguous-looking rows beyond it', () => {
    expect(contiguousPrecedingRun([36, 35, 34, 20, 19])).toEqual({ length: 2, endsAtGap: true });
  });

  it('is not a gap when the run reaches the first message of the chat', () => {
    expect(contiguousPrecedingRun([2, 1, 0])).toEqual({ length: 2, endsAtGap: false });
    expect(contiguousPrecedingRun([0])).toEqual({ length: 0, endsAtGap: false });
  });

  it('treats a missing or non-numeric index as a break, because contiguity cannot be verified', () => {
    expect(contiguousPrecedingRun([5, NaN, 3])).toEqual({ length: 0, endsAtGap: true });
    expect(contiguousPrecedingRun([NaN, 4, 3])).toEqual({ length: 0, endsAtGap: true });
  });

  it('treats a repeated or out-of-order index as a break', () => {
    expect(contiguousPrecedingRun([5, 5, 4])).toEqual({ length: 0, endsAtGap: true });
    expect(contiguousPrecedingRun([5, 6])).toEqual({ length: 0, endsAtGap: true });
  });

  it('copes with no rows at all', () => {
    expect(contiguousPrecedingRun([])).toEqual({ length: 0, endsAtGap: false });
  });
});
