import { describe, expect, it } from 'vitest';
import { BASE_SLOT, LOCAL_BASE, TurnSequence, isLocalPosition, positionOf } from './turnSequence';

const t = (...names: string[]) => names;

describe('positionOf', () => {
  it('gives a user message the even position and an assistant the odd one of its turn', () => {
    expect(positionOf(5000, 'user')).toBe(10000);
    expect(positionOf(5000, 'assistant')).toBe(10001);
    expect(positionOf(5001, 'user')).toBe(10002);
  });
  it('is a valid positional id (decimal digits only, at most 9 of them) across the whole frame', () => {
    expect(String(positionOf(LOCAL_BASE + 50, 'assistant'))).toMatch(/^\d{1,9}$/);
  });
  it('tells window-local positions from frame positions', () => {
    expect(isLocalPosition(positionOf(BASE_SLOT, 'user'))).toBe(false);
    expect(isLocalPosition(positionOf(LOCAL_BASE, 'user'))).toBe(true);
    expect(isLocalPosition(positionOf(LOCAL_BASE + 3, 'assistant'))).toBe(true);
  });
});

describe('TurnSequence: the first window becomes the base', () => {
  it('numbers it from BASE_SLOT in DOM order', () => {
    const seq = new TurnSequence();
    const r = seq.observe(t('a', 'b', 'c'));
    expect(r).toEqual({ slots: [BASE_SLOT, BASE_SLOT + 1, BASE_SLOT + 2], detached: false, reset: false, conflict: null });
    expect(seq.slotOf('b')).toBe(BASE_SLOT + 1);
  });

  it('does nothing for an empty window', () => {
    const seq = new TurnSequence();
    expect(seq.observe([])).toEqual({ slots: [], detached: false, reset: false, conflict: null });
    expect(seq.slotOf('a')).toBeNull();
  });

  it('is idempotent', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b', 'c'));
    const again = seq.observe(t('a', 'b', 'c'));
    expect(again.slots).toEqual([BASE_SLOT, BASE_SLOT + 1, BASE_SLOT + 2]);
    expect(seq.generation).toBe(0);
  });
});

describe('TurnSequence: a window that slides', () => {
  it('keeps known slots and extends downwards', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b', 'c'));
    const r = seq.observe(t('b', 'c', 'd', 'e'));
    expect(r.slots).toEqual([BASE_SLOT + 1, BASE_SLOT + 2, BASE_SLOT + 3, BASE_SLOT + 4]);
    expect(r.detached).toBe(false);
    expect(seq.slotOf('a')).toBe(BASE_SLOT);
  });

  it('extends upwards with lower slots', () => {
    const seq = new TurnSequence();
    seq.observe(t('c', 'd'));
    const r = seq.observe(t('a', 'b', 'c'));
    expect(r.slots).toEqual([BASE_SLOT - 2, BASE_SLOT - 1, BASE_SLOT]);
    expect(seq.slotOf('d')).toBe(BASE_SLOT + 1);
  });

  it('follows a long slow sweep without ever renumbering', () => {
    const seq = new TurnSequence();
    const ids = Array.from({ length: 27 }, (_, i) => `t${i}`);
    for (let s = 0; s + 5 <= ids.length; s++) seq.observe(ids.slice(s, s + 5));
    ids.forEach((id, i) => expect(seq.slotOf(id)).toBe(BASE_SLOT + i));
    expect(seq.generation).toBe(0);
    expect(seq.conflictCount).toBe(0);
  });
});

describe('TurnSequence: a window with no known turn (a jump) is detached', () => {
  it('gets window-local slots and stores nothing', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b', 'c'));
    const r = seq.observe(t('x', 'y'));
    expect(r).toEqual({ slots: [LOCAL_BASE, LOCAL_BASE + 1], detached: true, reset: false, conflict: null });
    expect(seq.slotOf('x')).toBeNull();
    expect(seq.slotOf('a')).toBe(BASE_SLOT);
  });

  it('is not a conflict, and does not touch the generation', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b'));
    seq.observe(t('x', 'y'));
    expect(seq.generation).toBe(0);
    expect(seq.conflictCount).toBe(0);
  });

  it('connects once a window overlaps the known frame, and numbers the new turns from it', () => {
    const seq = new TurnSequence();
    seq.observe(t('e', 'f', 'g')); // the base, at the "bottom"
    expect(seq.observe(t('a', 'b', 'c')).detached).toBe(true); // jumped to the top
    expect(seq.observe(t('b', 'c', 'd')).detached).toBe(true); // slid, still not connected
    const r = seq.observe(t('c', 'd', 'e')); // now it touches the base
    expect(r.detached).toBe(false);
    expect(r.slots).toEqual([BASE_SLOT - 2, BASE_SLOT - 1, BASE_SLOT]);
    expect(seq.slotOf('f')).toBe(BASE_SLOT + 1);
  });
});

describe('TurnSequence: a conflict resets the frame and is never silent', () => {
  it('detects an edited message: the new turn wants a slot the old one holds', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b', 'c', 'd'));
    const r = seq.observe(t('a', 'b', 'X')); // c was replaced by X
    expect(r.reset).toBe(true);
    expect(r.conflict).toMatch(/X/);
    expect(r.conflict).toMatch(/c/);
    expect(r.detached).toBe(false);
    expect(r.slots).toEqual([BASE_SLOT, BASE_SLOT + 1, BASE_SLOT + 2]); // the current window is the new base
    expect(seq.generation).toBe(1);
    expect(seq.conflictCount).toBe(1);
    expect(seq.slotOf('d')).toBeNull(); // old knowledge is gone
  });

  it('detects turns appearing in a different order', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b', 'c'));
    const r = seq.observe(t('b', 'a'));
    expect(r.reset).toBe(true);
    expect(r.conflict).toMatch(/order|position|slot/i);
    expect(seq.generation).toBe(1);
  });

  it('detects a known turn at a different distance from the anchor', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b', 'c', 'd'));
    const r = seq.observe(t('a', 'c')); // b vanished from between them
    expect(r.reset).toBe(true);
  });

  it('keeps counting conflicts across resets; generation counts resets', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b', 'c'));
    seq.observe(t('a', 'X'));
    seq.observe(t('a', 'Y'));
    expect(seq.generation).toBe(2);
    expect(seq.conflictCount).toBe(2);
  });

  it('numbers again from BASE_SLOT after a reset', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b', 'c'));
    seq.observe(t('b', 'a'));
    expect(seq.slotOf('b')).toBe(BASE_SLOT);
    expect(seq.slotOf('a')).toBe(BASE_SLOT + 1);
  });
});

describe('TurnSequence: windows it refuses to place', () => {
  it('treats a window with a repeated turn id as detached and stores nothing from it', () => {
    const seq = new TurnSequence();
    seq.observe(t('a', 'b'));
    const r = seq.observe(t('b', 'c', 'b'));
    expect(r.detached).toBe(true);
    expect(r.slots).toEqual([LOCAL_BASE, LOCAL_BASE + 1, LOCAL_BASE + 2]);
    expect(seq.slotOf('c')).toBeNull();
    expect(seq.conflictCount).toBe(0);
  });

  it('treats a window as detached rather than numbering below slot 0', () => {
    const seq = new TurnSequence({ baseSlot: 1 });
    seq.observe(t('a', 'b'));
    const r = seq.observe(t('x', 'y', 'z', 'a'));
    expect(r.detached).toBe(true);
    expect(seq.slotOf('x')).toBeNull();
  });

  it('treats a window as detached rather than numbering into the window-local range', () => {
    const seq = new TurnSequence({ baseSlot: LOCAL_BASE - 2 });
    seq.observe(t('a', 'b'));
    const r = seq.observe(t('b', 'c', 'd', 'e'));
    expect(r.detached).toBe(true);
    expect(seq.slotOf('e')).toBeNull();
  });
});
