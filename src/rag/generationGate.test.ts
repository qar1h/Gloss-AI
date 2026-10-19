import { describe, expect, it } from 'vitest';
import { createGenerationGate, generationIsCurrent } from './generationGate';

describe('generationIsCurrent', () => {
  it('is always true for a site with no generations (claude.ai)', () => {
    expect(generationIsCurrent(null, null)).toBe(true);
    expect(generationIsCurrent(null, 'g9')).toBe(true);
  });
  it('is true only while the page is still numbered the way the ids were read', () => {
    expect(generationIsCurrent('g1', 'g1')).toBe(true);
    expect(generationIsCurrent('g1', 'g2')).toBe(false);
  });
  it('is false when the page can no longer say which numbering it has (mid-navigation)', () => {
    expect(generationIsCurrent('g1', null)).toBe(false);
  });
});

function makeGate() {
  const wiped: string[] = [];
  const gate = createGenerationGate(async (conversationId) => {
    wiped.push(conversationId);
  });
  return { gate, wiped };
}

describe('createGenerationGate', () => {
  it('never wipes for a site with no generation (null / undefined)', async () => {
    const { gate, wiped } = makeGate();
    await gate.ensure('chat', null);
    await gate.ensure('chat', undefined);
    expect(wiped).toEqual([]);
  });

  it('wipes the first time a generation is seen for a chat (a fresh page load)', async () => {
    const { gate, wiped } = makeGate();
    await gate.ensure('chat', 'g1');
    expect(wiped).toEqual(['chat']);
  });

  it('does not wipe again for the same generation', async () => {
    const { gate, wiped } = makeGate();
    await gate.ensure('chat', 'g1');
    await gate.ensure('chat', 'g1');
    expect(wiped).toEqual(['chat']);
  });

  it('wipes again when the generation changes', async () => {
    const { gate, wiped } = makeGate();
    await gate.ensure('chat', 'g1');
    await gate.ensure('chat', 'g2');
    expect(wiped).toEqual(['chat', 'chat']);
  });

  it('tracks each chat on its own', async () => {
    const { gate, wiped } = makeGate();
    await gate.ensure('a', 'g1');
    await gate.ensure('b', 'g1');
    await gate.ensure('a', 'g1');
    expect(wiped).toEqual(['a', 'b']);
  });

  it('wipes once when two callers ask at the same time, and both wait for it', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = createGenerationGate(
      (conversationId) =>
        new Promise<void>((resolve) => {
          events.push(`wipe-start:${conversationId}`);
          release = () => {
            events.push('wipe-end');
            resolve();
          };
        }),
    );
    const first = gate.ensure('chat', 'g1').then(() => events.push('first-done'));
    const second = gate.ensure('chat', 'g1').then(() => events.push('second-done'));
    await Promise.resolve();
    expect(events).toEqual(['wipe-start:chat']); // nobody proceeds while the wipe runs
    release();
    await Promise.all([first, second]);
    expect(events.filter((e) => e.startsWith('wipe-start'))).toHaveLength(1);
    expect(events.indexOf('wipe-end')).toBeLessThan(events.indexOf('first-done'));
    expect(events.indexOf('wipe-end')).toBeLessThan(events.indexOf('second-done'));
  });

  it('a newer generation asked for during a wipe is wiped for after it', async () => {
    const wipes: string[] = [];
    const releases: (() => void)[] = [];
    const gate = createGenerationGate(
      () =>
        new Promise<void>((resolve) => {
          wipes.push('w');
          releases.push(resolve);
        }),
    );
    const a = gate.ensure('chat', 'g1');
    const b = gate.ensure('chat', 'g2');
    await Promise.resolve();
    releases[0]!();
    await a; // g1 is applied...
    await Promise.resolve();
    await Promise.resolve();
    expect(wipes).toHaveLength(2); // ...and g2 now gets its own wipe
    releases[1]!();
    await b;
  });

  it('does not mark a generation as applied when the wipe fails, so the next call retries', async () => {
    let calls = 0;
    const gate = createGenerationGate(async () => {
      calls++;
      if (calls === 1) throw new Error('db blocked');
    });
    await expect(gate.ensure('chat', 'g1')).rejects.toThrow('db blocked');
    await gate.ensure('chat', 'g1');
    expect(calls).toBe(2);
  });

  it('calls the after-wipe listeners with the chat that was wiped', async () => {
    const { gate } = makeGate();
    const seen: string[] = [];
    gate.onWiped((id) => seen.push(id));
    await gate.ensure('chat', 'g1');
    await gate.ensure('chat', 'g1');
    expect(seen).toEqual(['chat']);
  });
});
