// Keeps a stored chat index from outliving the numbering it was written under. Pure
// orchestration (the actual wipe is injected), so it is unit-tested.
//
// A site whose message positions are only valid for part of a page's life (ChatGPT: positions come
// from a session-scoped frame, see sites/turnSequence.ts) reports a `generation` string. When it
// differs from the one the stored rows were written under, those rows are numbered in a frame that
// no longer exists, so reading them would give a well-formed prompt with chunks in the wrong order
// and nothing logged. The gate wipes the chat's rows first; everyone who reads or writes the index
// calls `ensure` before they do. A fresh page load has applied nothing, so its first call wipes:
// the index is per page load on those sites. Sites with no generation (Claude) are never touched.

export interface GenerationGate {
  ensure(conversationId: string, generation: string | null | undefined): Promise<void>;
  /** Called after a chat's rows were wiped (to drop in-memory caches that describe them). */
  onWiped(listener: (conversationId: string) => void): void;
}

export function createGenerationGate(wipe: (conversationId: string) => Promise<void>): GenerationGate {
  const applied = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const listeners: ((conversationId: string) => void)[] = [];

  async function ensure(conversationId: string, generation: string | null | undefined): Promise<void> {
    if (generation === null || generation === undefined) return;
    for (;;) {
      const running = inFlight.get(conversationId);
      if (running) {
        await running.catch(() => undefined); // someone else's wipe; look again once it is over
        continue;
      }
      if (applied.get(conversationId) === generation) return;

      const wiping = wipe(conversationId).then(() => {
        applied.set(conversationId, generation);
        for (const listener of listeners) listener(conversationId);
      });
      inFlight.set(conversationId, wiping);
      try {
        await wiping; // a failure propagates and leaves the generation unapplied, so the next call retries
      } finally {
        inFlight.delete(conversationId);
      }
    }
  }

  return { ensure, onWiped: (listener) => void listeners.push(listener) };
}
