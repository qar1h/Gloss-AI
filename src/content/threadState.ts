// The popup's thread as a small state machine (v10; supersedes v9's simplerState.ts). One state per
// open popup. Request 0 is the first explanation; each Simpler press or follow-up that sends is the
// next request number, and a done or error for any request but the current one is ignored, so a
// late message from an earlier call can never change the thread.
//
// What the thread holds is what later prompts quote back, so it is guarded here:
//   - only FINISHED answers enter `turns`: a failed or half-streamed answer never does;
//   - Simpler only rewrites the LATEST answer, replacing it in place: if it rewrote an earlier one,
//     later follow-ups would have been answered against a version that no longer exists, and the
//     next prompt would quote the thread wrong without any error (the project's recurring bug);
//   - the level is the popup's: a follow-up is asked at the level of the latest answer.
// One call at a time: a press or a question in any phase but idle does nothing. Pure.

import { MAX_SIMPLICITY_LEVEL } from '@/context/levels';
import type { FollowUpInput } from '@/context/thread';

/** turns[0] is the explanation (question null); the rest are follow-ups, oldest first. */
export interface FinishedTurn {
  question: string | null;
  answer: string;
}

/**
 *   first        — the first explanation is still streaming
 *   idle         — the latest answer is finished; a press or a question may send
 *   asking       — a follow-up question is being answered
 *   regenerating — Simpler is rewriting the latest answer (the old text stays until its first chunk)
 *   unavailable  — the first explanation failed, so there is nothing to simplify or ask about
 */
export type ThreadPhase = 'first' | 'idle' | 'asking' | 'regenerating' | 'unavailable';

export interface ThreadState {
  phase: ThreadPhase;
  /** The popup's level: the level of the latest finished answer. */
  level: number;
  /** The level in flight while regenerating, else null. */
  pendingLevel: number | null;
  /** The number of the current call. */
  request: number;
  /** Finished answers only, each in its latest version. */
  turns: FinishedTurn[];
  /** The question in flight while asking, else null. */
  pendingQuestion: string | null;
}

export type ThreadEvent =
  | { type: 'press' }
  | { type: 'ask'; question: string }
  | { type: 'done'; request: number; text: string }
  | { type: 'error'; request: number };

export type ThreadSend =
  | { kind: 'explanation'; level: number; request: number }
  | {
      kind: 'follow-up';
      level: number;
      request: number;
      input: FollowUpInput;
      /** 1-based number of the follow-up this call answers (or rewrites, with `regenerate`). */
      followUpNumber: number;
      /** true: Simpler rewriting the latest follow-up's answer; false: a new question. */
      regenerate: boolean;
    };

export interface SimplerButtonView {
  visible: boolean;
  enabled: boolean;
  label: string;
  title: string;
}

export interface ComposerView {
  visible: boolean;
  canSend: boolean;
}

export function initialThreadState(): ThreadState {
  return { phase: 'first', level: 0, pendingLevel: null, request: 0, turns: [], pendingQuestion: null };
}

function exchangesOf(turns: FinishedTurn[]): { question: string; answer: string }[] {
  return turns.map((t) => ({ question: t.question ?? '', answer: t.answer }));
}

export function threadReduce(state: ThreadState, event: ThreadEvent): { state: ThreadState; send: ThreadSend | null } {
  const unchanged = { state, send: null };

  if (event.type === 'press') {
    if (state.phase !== 'idle' || state.level >= MAX_SIMPLICITY_LEVEL) return unchanged;
    const level = state.level + 1;
    const request = state.request + 1;
    const next: ThreadState = { ...state, phase: 'regenerating', pendingLevel: level, request };
    if (state.turns.length === 1) return { state: next, send: { kind: 'explanation', level, request } };
    const latest = state.turns[state.turns.length - 1]!;
    return {
      state: next,
      send: {
        kind: 'follow-up',
        regenerate: true,
        level,
        request,
        followUpNumber: state.turns.length - 1,
        input: {
          explanation: state.turns[0]!.answer,
          exchanges: exchangesOf(state.turns.slice(1, -1)),
          question: latest.question ?? '',
        },
      },
    };
  }

  if (event.type === 'ask') {
    const question = event.question.trim();
    if (state.phase !== 'idle' || !question) return unchanged;
    const request = state.request + 1;
    return {
      state: { ...state, phase: 'asking', pendingQuestion: question, request },
      send: {
        kind: 'follow-up',
        regenerate: false,
        level: state.level,
        request,
        followUpNumber: state.turns.length,
        input: { explanation: state.turns[0]!.answer, exchanges: exchangesOf(state.turns.slice(1)), question },
      },
    };
  }

  if (event.request !== state.request) return unchanged;

  switch (state.phase) {
    case 'first':
      return event.type === 'done'
        ? { state: { ...state, phase: 'idle', turns: [{ question: null, answer: event.text }] }, send: null }
        : { state: { ...state, phase: 'unavailable' }, send: null };
    case 'regenerating': {
      if (event.type === 'error') return { state: { ...state, phase: 'idle', pendingLevel: null }, send: null };
      const turns = [...state.turns];
      turns[turns.length - 1] = { question: turns[turns.length - 1]!.question, answer: event.text };
      return {
        state: { ...state, phase: 'idle', level: state.pendingLevel ?? state.level, pendingLevel: null, turns },
        send: null,
      };
    }
    case 'asking': {
      const turns =
        event.type === 'done' ? [...state.turns, { question: state.pendingQuestion, answer: event.text }] : state.turns;
      return { state: { ...state, phase: 'idle', pendingQuestion: null, turns }, send: null };
    }
    default:
      return unchanged;
  }
}

export function simplerButtonView(state: ThreadState): SimplerButtonView {
  switch (state.phase) {
    case 'first':
      return { visible: true, enabled: false, label: 'Simpler', title: 'Available when this explanation finishes' };
    case 'asking':
      return { visible: true, enabled: false, label: 'Simpler', title: 'Available when this answer finishes' };
    case 'regenerating':
      return { visible: true, enabled: false, label: 'Simplifying…', title: '' };
    case 'unavailable':
      return { visible: false, enabled: false, label: 'Simpler', title: '' };
    case 'idle':
      return state.level >= MAX_SIMPLICITY_LEVEL
        ? { visible: true, enabled: false, label: 'Simplest', title: 'This is already the simplest version' }
        : { visible: true, enabled: true, label: 'Simpler', title: 'Explain this again, more simply' };
  }
}

/** The text box can be typed in while an answer streams; only sending waits. */
export function composerView(state: ThreadState): ComposerView {
  if (state.phase === 'unavailable') return { visible: false, canSend: false };
  return { visible: true, canSend: state.phase === 'idle' };
}
