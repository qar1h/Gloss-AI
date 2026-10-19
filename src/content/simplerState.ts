// The popup's "Simpler" button as a small state machine (v9). One state per open popup: the
// level-0 call is request 0, and each press that sends is the next request number. A done or
// error for any request but the current one is ignored, so a late message from an earlier call
// can never move the level. Pure — the popup and the port live in index.ts and ui/popup.ts.

import { MAX_SIMPLICITY_LEVEL } from '@/context/levels';

/**
 *   first        — the level-0 explanation is still streaming
 *   idle         — an explanation is shown and finished; a press may send
 *   regenerating — a simpler level is in flight (the old text stays until its first chunk)
 *   unavailable  — the level-0 explanation failed, so there is nothing to simplify
 */
export type SimplerPhase = 'first' | 'idle' | 'regenerating' | 'unavailable';

export interface SimplerState {
  phase: SimplerPhase;
  /** The level of the explanation on screen once its call has finished. */
  shownLevel: number;
  /** The level in flight while regenerating, else null. */
  pendingLevel: number | null;
  /** The number of the current call. */
  request: number;
}

export type SimplerEvent = { type: 'press' } | { type: 'done'; request: number } | { type: 'error'; request: number };

export interface SimplerSend {
  level: number;
  request: number;
}

export interface SimplerButtonView {
  visible: boolean;
  enabled: boolean;
  label: string;
  title: string;
}

export function initialSimplerState(): SimplerState {
  return { phase: 'first', shownLevel: 0, pendingLevel: null, request: 0 };
}

export function simplerReduce(
  state: SimplerState,
  event: SimplerEvent,
): { state: SimplerState; send: SimplerSend | null } {
  const unchanged = { state, send: null };

  if (event.type === 'press') {
    if (state.phase !== 'idle' || state.shownLevel >= MAX_SIMPLICITY_LEVEL) return unchanged;
    const send = { level: state.shownLevel + 1, request: state.request + 1 };
    return { state: { ...state, phase: 'regenerating', pendingLevel: send.level, request: send.request }, send };
  }

  if (event.request !== state.request) return unchanged;

  if (state.phase === 'first') {
    return { state: { ...state, phase: event.type === 'done' ? 'idle' : 'unavailable' }, send: null };
  }
  if (state.phase === 'regenerating') {
    const shownLevel = event.type === 'done' ? (state.pendingLevel ?? state.shownLevel) : state.shownLevel;
    return { state: { ...state, phase: 'idle', shownLevel, pendingLevel: null }, send: null };
  }
  return unchanged;
}

export function simplerButtonView(state: SimplerState): SimplerButtonView {
  switch (state.phase) {
    case 'first':
      return { visible: true, enabled: false, label: 'Simpler', title: 'Available when this explanation finishes' };
    case 'regenerating':
      return { visible: true, enabled: false, label: 'Simplifying…', title: '' };
    case 'unavailable':
      return { visible: false, enabled: false, label: 'Simpler', title: '' };
    case 'idle':
      return state.shownLevel >= MAX_SIMPLICITY_LEVEL
        ? { visible: true, enabled: false, label: 'Simplest', title: 'This is already the simplest version' }
        : { visible: true, enabled: true, label: 'Simpler', title: 'Explain this again, more simply' };
  }
}
