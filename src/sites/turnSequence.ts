// Gives ChatGPT's turns positions. Pure — no DOM — so it is unit-tested.
//
// Why it exists: ChatGPT's page has no absolute index for a turn. Its only stable identity is
// `data-turn-key` (a UUID), and the number it labels turns with (`fallback-turn-N`) follows the
// render window, not the chat. What the page DOES guarantee (checked live, over a 27-turn chat:
// one chain, no conflicts) is that the turns mounted at one moment are consecutive in the chat.
// So positions are assigned in a session-stable frame from that adjacency, never from a label.
//
// The rules, in short:
//  - the first window seen is the base of the frame;
//  - a later window that contains a turn we already placed is numbered from it, by distance;
//  - a window that contains none is DETACHED: it gets window-local numbers, and nothing is
//    stored, because we cannot say where it sits relative to what is indexed;
//  - if a window disagrees with what we placed (a turn at another distance, or a different turn
//    wanting a slot someone else holds, as after an edit), that is a CONFLICT: the frame is
//    thrown away and the current window, which is the freshest truth, becomes the new base.
//    A conflict is never silent: `generation` and `conflictCount` are what the caller shows.

export type Role = 'user' | 'assistant';

/** The first slot of the frame. Lower slots are for turns discovered above the first window. */
export const BASE_SLOT = 5000;
/** Slots at or above this belong to detached windows. The frame never reaches it. */
export const LOCAL_BASE = 100_000;

/** A message's position: a user message is even, the assistant message of the same turn is the next odd one. */
export function positionOf(slot: number, role: Role): number {
  return slot * 2 + (role === 'assistant' ? 1 : 0);
}

/** True for a position that came from a detached window (not comparable with the indexed frame). */
export function isLocalPosition(position: number): boolean {
  return position >= LOCAL_BASE * 2;
}

export interface Observation {
  /** One slot per turn of the window passed in, same order. */
  slots: number[];
  /** True when `slots` are window-local: the window could not be placed in the frame. */
  detached: boolean;
  /** True when this call threw the frame away because of a conflict. */
  reset: boolean;
  /** Plain-words description of the conflict, when `reset` is true. */
  conflict: string | null;
}

export interface TurnSequenceOptions {
  baseSlot?: number;
}

export class TurnSequence {
  /** Number of times the frame was thrown away. Changes whenever stored positions stop being valid. */
  generation = 0;
  /** Conflicts seen over the life of this object; never reset, so a note can stay visible. */
  conflictCount = 0;

  private readonly baseSlot: number;
  private readonly slotByTurn = new Map<string, number>();
  private readonly turnBySlot = new Map<number, string>();

  constructor(options: TurnSequenceOptions = {}) {
    this.baseSlot = options.baseSlot ?? BASE_SLOT;
  }

  slotOf(turnId: string): number | null {
    return this.slotByTurn.get(turnId) ?? null;
  }

  observe(window: readonly string[]): Observation {
    if (window.length === 0) return { slots: [], detached: false, reset: false, conflict: null };
    if (new Set(window).size !== window.length) return this.detach(window); // the same turn twice: do not trust it

    const anchorIndex = window.findIndex((id) => this.slotByTurn.has(id));

    if (anchorIndex === -1) {
      if (this.slotByTurn.size === 0) return this.place(window, this.baseSlot) ?? this.detach(window);
      return this.detach(window);
    }

    const anchorSlot = this.slotByTurn.get(window[anchorIndex]!)!;
    const first = anchorSlot - anchorIndex;

    for (let i = 0; i < window.length; i++) {
      const id = window[i]!;
      const slot = first + i;
      const known = this.slotByTurn.get(id);
      if (known !== undefined && known !== slot) {
        return this.reseed(
          window,
          `turn ${short(id)} was at slot ${known} but this window puts it at slot ${slot} (the turns are in a different order)`,
        );
      }
      const holder = this.turnBySlot.get(slot);
      if (known === undefined && holder !== undefined && holder !== id) {
        return this.reseed(
          window,
          `turn ${short(id)} sits where turn ${short(holder)} was at slot ${slot} (the chat changed here, for example an edit)`,
        );
      }
    }

    return this.place(window, first) ?? this.detach(window);
  }

  /** Stores `window` starting at `first`, or returns null if that would leave the frame's range. */
  private place(window: readonly string[], first: number): Observation | null {
    if (first < 0 || first + window.length - 1 >= LOCAL_BASE) return null;
    window.forEach((id, i) => {
      this.slotByTurn.set(id, first + i);
      this.turnBySlot.set(first + i, id);
    });
    return { slots: window.map((_, i) => first + i), detached: false, reset: false, conflict: null };
  }

  private detach(window: readonly string[]): Observation {
    return { slots: window.map((_, i) => LOCAL_BASE + i), detached: true, reset: false, conflict: null };
  }

  private reseed(window: readonly string[], conflict: string): Observation {
    this.slotByTurn.clear();
    this.turnBySlot.clear();
    this.generation++;
    this.conflictCount++;
    const placed = this.place(window, this.baseSlot);
    if (placed) return { ...placed, reset: true, conflict };
    // The window cannot even fit the frame: still report the reset, and leave the frame empty.
    return { ...this.detach(window), reset: true, conflict };
  }
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
