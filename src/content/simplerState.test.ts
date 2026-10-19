import { describe, expect, it } from 'vitest';
import {
  initialSimplerState,
  simplerButtonView,
  simplerReduce,
  type SimplerEvent,
  type SimplerSend,
  type SimplerState,
} from './simplerState';

const press: SimplerEvent = { type: 'press' };
const done = (request: number): SimplerEvent => ({ type: 'done', request });
const error = (request: number): SimplerEvent => ({ type: 'error', request });

function run(events: SimplerEvent[]): { state: SimplerState; sends: SimplerSend[] } {
  let state = initialSimplerState();
  const sends: SimplerSend[] = [];
  for (const event of events) {
    const result = simplerReduce(state, event);
    state = result.state;
    if (result.send) sends.push(result.send);
  }
  return { state, sends };
}

describe('simplerReduce', () => {
  it('starts disabled while the first explanation streams', () => {
    expect(simplerButtonView(initialSimplerState())).toEqual({
      visible: true,
      enabled: false,
      label: 'Simpler',
      title: 'Available when this explanation finishes',
    });
  });

  it('a press before the first explanation finishes sends nothing', () => {
    expect(run([press]).sends).toEqual([]);
  });

  it('first done enables it; a press sends level 1 as request 1', () => {
    expect(simplerButtonView(run([done(0)]).state)).toEqual({
      visible: true,
      enabled: true,
      label: 'Simpler',
      title: 'Explain this again, more simply',
    });
    const { state, sends } = run([done(0), press]);
    expect(sends).toEqual([{ level: 1, request: 1 }]);
    expect(state.phase).toBe('regenerating');
    expect(simplerButtonView(state)).toMatchObject({ enabled: false, label: 'Simplifying…' });
  });

  it('a second press while regenerating sends nothing', () => {
    expect(run([done(0), press, press]).sends).toEqual([{ level: 1, request: 1 }]);
  });

  it('done commits the level', () => {
    const { state } = run([done(0), press, done(1)]);
    expect(state.shownLevel).toBe(1);
    expect(state.phase).toBe('idle');
    expect(simplerButtonView(state)).toMatchObject({ enabled: true, label: 'Simpler' });
  });

  it('pressing through every level ends at Simplest', () => {
    const { state, sends } = run([done(0), press, done(1), press, done(2), press, done(3), press]);
    expect(sends.map((s) => s.level)).toEqual([1, 2, 3]);
    expect(simplerButtonView(state)).toEqual({
      visible: true,
      enabled: false,
      label: 'Simplest',
      title: 'This is already the simplest version',
    });
  });

  it('error keeps the shown level and a retry asks for the same level again', () => {
    const failed = run([done(0), press, error(1)]).state;
    expect(failed.shownLevel).toBe(0);
    expect(failed.phase).toBe('idle');
    expect(run([done(0), press, error(1), press]).sends).toEqual([
      { level: 1, request: 1 },
      { level: 1, request: 2 },
    ]);
  });

  it('a done or error from an earlier request is ignored', () => {
    for (const late of [done(0), error(0)]) {
      const { state } = run([done(0), press, late]);
      expect(state.phase).toBe('regenerating');
      expect(state.shownLevel).toBe(0);
      expect(state.pendingLevel).toBe(1);
    }
  });

  it('a failed first explanation hides the button for good', () => {
    const { state, sends } = run([error(0), press, done(0)]);
    expect(simplerButtonView(state).visible).toBe(false);
    expect(sends).toEqual([]);
  });

  it('does not change the state it is given', () => {
    const state = run([done(0)]).state;
    const before = { ...state };
    simplerReduce(state, press);
    expect(state).toEqual(before);
  });
});
