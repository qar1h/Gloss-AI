import { describe, expect, it } from 'vitest';
import {
  composerView,
  describeSend,
  initialThreadState,
  simplerButtonView,
  threadReduce,
  type ThreadEvent,
  type ThreadSend,
  type ThreadState,
} from './threadState';

const press: ThreadEvent = { type: 'press' };
const ask = (question: string): ThreadEvent => ({ type: 'ask', question });
const done = (request: number, text = `answer ${request}`): ThreadEvent => ({ type: 'done', request, text });
const error = (request: number): ThreadEvent => ({ type: 'error', request });

function run(events: ThreadEvent[], from: ThreadState = initialThreadState()): { state: ThreadState; sends: ThreadSend[] } {
  let state = from;
  const sends: ThreadSend[] = [];
  for (const event of events) {
    const result = threadReduce(state, event);
    state = result.state;
    if (result.send) sends.push(result.send);
  }
  return { state, sends };
}

describe('threadReduce — Simpler (ported from v9)', () => {
  it('starts disabled while the first explanation streams', () => {
    expect(simplerButtonView(initialThreadState())).toEqual({
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
    expect(sends).toEqual([{ kind: 'explanation', level: 1, request: 1 }]);
    expect(state.phase).toBe('regenerating');
    expect(simplerButtonView(state)).toMatchObject({ enabled: false, label: 'Simplifying…' });
  });

  it('a second press while regenerating sends nothing', () => {
    expect(run([done(0), press, press]).sends).toEqual([{ kind: 'explanation', level: 1, request: 1 }]);
  });

  it('done commits the level and replaces the explanation', () => {
    const { state } = run([done(0, 'first'), press, done(1, 'simpler')]);
    expect(state.level).toBe(1);
    expect(state.phase).toBe('idle');
    expect(state.turns).toEqual([{ question: null, answer: 'simpler' }]);
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
    const failed = run([done(0, 'first'), press, error(1)]).state;
    expect(failed.level).toBe(0);
    expect(failed.phase).toBe('idle');
    expect(failed.turns).toEqual([{ question: null, answer: 'first' }]);
    expect(run([done(0), press, error(1), press]).sends).toEqual([
      { kind: 'explanation', level: 1, request: 1 },
      { kind: 'explanation', level: 1, request: 2 },
    ]);
  });

  it('a done or error from an earlier request is ignored', () => {
    for (const late of [done(0), error(0)]) {
      const { state } = run([done(0), press, late]);
      expect(state.phase).toBe('regenerating');
      expect(state.level).toBe(0);
      expect(state.pendingLevel).toBe(1);
    }
  });

  it('a failed first explanation hides the button and the text box for good', () => {
    const { state, sends } = run([error(0), press, ask('why?'), done(0)]);
    expect(simplerButtonView(state).visible).toBe(false);
    expect(composerView(state)).toEqual({ visible: false, canSend: false });
    expect(sends).toEqual([]);
  });

  it('does not change the state it is given', () => {
    const state = run([done(0), ask('why?'), done(1)]).state;
    const before = structuredClone(state);
    threadReduce(state, press);
    threadReduce(state, ask('again?'));
    expect(state).toEqual(before);
  });
});

describe('threadReduce — follow-ups', () => {
  it('an ask before the first explanation finishes sends nothing', () => {
    expect(run([ask('why?')]).sends).toEqual([]);
  });

  it('a follow-up carries the explanation and is follow-up 1', () => {
    const { state, sends } = run([done(0, 'EXPL'), ask('  why?  ')]);
    expect(sends).toEqual([
      {
        kind: 'follow-up',
        regenerate: false,
        level: 0,
        request: 1,
        followUpNumber: 1,
        input: { explanation: 'EXPL', exchanges: [], question: 'why?' },
      },
    ]);
    expect(state.phase).toBe('asking');
    expect(state.pendingQuestion).toBe('why?');
  });

  it('a follow-up inherits the level', () => {
    const { sends } = run([done(0), press, done(1), ask('why?')]);
    expect(sends[1]).toMatchObject({ kind: 'follow-up', level: 1, followUpNumber: 1 });
  });

  it('a finished follow-up joins the thread', () => {
    const { state } = run([done(0, 'EXPL'), ask('why?'), done(1, 'because')]);
    expect(state.phase).toBe('idle');
    expect(state.turns).toEqual([
      { question: null, answer: 'EXPL' },
      { question: 'why?', answer: 'because' },
    ]);
    expect(state.pendingQuestion).toBeNull();
  });

  it('the history is the earlier finished follow-ups, oldest first', () => {
    const { sends } = run([done(0, 'EXPL'), ask('q1'), done(1, 'a1'), ask('q2'), done(2, 'a2'), ask('q3')]);
    expect(sends.at(-1)).toMatchObject({
      followUpNumber: 3,
      input: {
        explanation: 'EXPL',
        exchanges: [
          { question: 'q1', answer: 'a1' },
          { question: 'q2', answer: 'a2' },
        ],
        question: 'q3',
      },
    });
  });

  it('a failed follow-up never enters the history', () => {
    const failed = run([done(0, 'EXPL'), ask('q1'), error(1)]).state;
    expect(failed.phase).toBe('idle');
    expect(failed.turns).toEqual([{ question: null, answer: 'EXPL' }]);
    expect(failed.pendingQuestion).toBeNull();
    const { sends } = run([ask('q2')], failed);
    expect(sends[0]).toMatchObject({ followUpNumber: 1, input: { exchanges: [], question: 'q2' } });
  });

  it('Simpler on the latest follow-up replaces only that answer, and the next follow-up carries the new version', () => {
    const before = run([done(0, 'EXPL'), ask('q1'), done(1, 'old')]).state;
    const pressed = run([press], before);
    expect(pressed.sends).toEqual([
      {
        kind: 'follow-up',
        regenerate: true,
        level: 1,
        request: 2,
        followUpNumber: 1,
        input: { explanation: 'EXPL', exchanges: [], question: 'q1' },
      },
    ]);
    const after = run([done(2, 'new')], pressed.state).state;
    expect(after.turns[0]).toBe(before.turns[0]);
    expect(after.turns[1]).toEqual({ question: 'q1', answer: 'new' });
    expect(after.level).toBe(1);
    const next = run([ask('q2')], after).sends[0]!;
    expect(next).toMatchObject({ level: 1, followUpNumber: 2, input: { exchanges: [{ question: 'q1', answer: 'new' }] } });
  });

  it('Simpler on the latest of several follow-ups sends the ones before it as history', () => {
    const { sends } = run([done(0, 'EXPL'), ask('q1'), done(1, 'a1'), ask('q2'), done(2, 'a2'), press]);
    expect(sends.at(-1)).toMatchObject({
      regenerate: true,
      followUpNumber: 2,
      input: { exchanges: [{ question: 'q1', answer: 'a1' }], question: 'q2' },
    });
  });

  it('a failed Simpler on a follow-up keeps its answer and the level', () => {
    const { state } = run([done(0, 'EXPL'), ask('q1'), done(1, 'a1'), press, error(2)]);
    expect(state.turns[1]).toEqual({ question: 'q1', answer: 'a1' });
    expect(state.level).toBe(0);
    expect(state.phase).toBe('idle');
  });

  it('one call at a time', () => {
    expect(run([done(0), ask('q1'), ask('q2'), press]).sends).toHaveLength(1);
    expect(run([done(0), press, ask('q1')]).sends).toHaveLength(1);
  });

  it('a blank question sends nothing', () => {
    expect(run([done(0), ask('   ')]).sends).toEqual([]);
  });

  it('a stale done is ignored', () => {
    const { state } = run([done(0, 'EXPL'), ask('q1'), error(1), ask('q2'), done(1, 'late')]);
    expect(state.phase).toBe('asking');
    expect(state.turns).toEqual([{ question: null, answer: 'EXPL' }]);
  });
});

describe('describeSend', () => {
  it('labels each kind of call for the debug report', () => {
    expect(describeSend({ kind: 'explanation', level: 0, request: 0 })).toBe('');
    expect(describeSend({ kind: 'explanation', level: 2, request: 2 })).toBe(' (Simpler, level 2 of 3)');
    const input = { explanation: 'e', exchanges: [], question: 'q' };
    expect(describeSend({ kind: 'follow-up', regenerate: false, level: 1, request: 3, followUpNumber: 2, input })).toBe(
      ' (follow-up 2, level 1 of 3)',
    );
    expect(describeSend({ kind: 'follow-up', regenerate: true, level: 3, request: 4, followUpNumber: 2, input })).toBe(
      ' (follow-up 2, Simpler, level 3 of 3)',
    );
  });
});

describe('views', () => {
  it('composer: typing is allowed while an answer streams, sending waits', () => {
    expect(composerView(initialThreadState())).toEqual({ visible: true, canSend: false });
    expect(composerView(run([done(0)]).state)).toEqual({ visible: true, canSend: true });
    expect(composerView(run([done(0), ask('q')]).state)).toEqual({ visible: true, canSend: false });
    expect(composerView(run([done(0), press]).state)).toEqual({ visible: true, canSend: false });
  });

  it('Simpler waits while a follow-up is answered', () => {
    expect(simplerButtonView(run([done(0), ask('q')]).state)).toEqual({
      visible: true,
      enabled: false,
      label: 'Simpler',
      title: 'Available when this answer finishes',
    });
  });
});
