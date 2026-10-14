import { describe, expect, it } from 'vitest';
import { firstNonPositionId, positionFromId } from './positionId';

describe('firstNonPositionId', () => {
  it('is null when every id is a position (or there are none)', () => {
    expect(firstNonPositionId([])).toBeNull();
    expect(firstNonPositionId(['0', '1', '217'])).toBeNull();
  });

  it('returns the first offending id', () => {
    expect(firstNonPositionId(['3', '027e3606-7f6b', '', '4'])).toBe('027e3606-7f6b');
    expect(firstNonPositionId(['', '4'])).toBe('');
  });
});

describe('positionFromId', () => {
  it('accepts plain non-negative integers', () => {
    expect(positionFromId('0')).toBe(0);
    expect(positionFromId('7')).toBe(7);
    expect(positionFromId('217')).toBe(217);
    expect(positionFromId('406')).toBe(406);
  });

  it('rejects ids that Number() would silently mangle', () => {
    const bad = [
      '', // Number('') is 0: would file the message at position 0
      ' ', // also 0
      '3af60251-1934-47c0-a2ff-05f166b7f3e9', // a site uuid: NaN
      '027e3606', // starts with digits but is not an integer
      '1e3', // Number('1e3') is 1000
      '-1',
      '1.5',
      '0x10', // Number('0x10') is 16
      'NaN',
      '12 ', // trailing whitespace
      '１２', // full-width digits
    ];
    for (const id of bad) expect(positionFromId(id), JSON.stringify(id)).toBeNull();
  });

  it('rejects ids too long to be a message count', () => {
    expect(positionFromId('1234567890')).toBeNull();
  });
});
