// The message-id contract: an id is the message's position in the chat, as a decimal integer
// string. Chunk ordering (`Number(messageId) * 1000`), the before/after labels in the prompt and
// coverage all do Number(id). A site uuid would give NaN, and '' or '1e3' would give a number
// that is quietly wrong — a well-formed prompt with the chat in the wrong order and no error.
// So ids are checked where they enter the pipeline, and refused loudly rather than guessed.

const POSITION_ID = /^\d{1,9}$/;

export function positionFromId(id: string): number | null {
  return POSITION_ID.test(id) ? Number(id) : null;
}

/** The first id in `ids` that is not a position, or null if they all are. */
export function firstNonPositionId(ids: readonly string[]): string | null {
  for (const id of ids) if (positionFromId(id) === null) return id;
  return null;
}
