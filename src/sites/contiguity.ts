// The one rule that decides whether the rows before a message on the page really are the
// messages before it in the chat. Pure — no DOM — so it is unit-tested.
//
// Why it exists: claude.ai virtualizes long chats, so the mounted rows can be disconnected
// "islands" (seen live: rows 29–36, 217, 403–405). Walking DOM siblings across the gap gives
// the previous *mounted* row, not the previous message: a highlight in 217 would get message
// 126 as "the question that produced it". That produced a well-formed prompt with the wrong
// conversation in it and no error anywhere, so contiguity is checked on `data-index`.

export interface ContiguousRun {
  /** How many rows after the first are contiguous (each exactly one index before the row after it). */
  length: number;
  /**
   * True if the run stopped because older messages exist but aren't there — a break in the
   * indices, an unreadable index, or running out of rows before reaching message 0. False only
   * when the run reached the very first message of the chat.
   */
  endsAtGap: boolean;
}

/**
 * `indices` are the `data-index` values of the page's rows, nearest-first, starting with the
 * row you are walking back from (e.g. `[217, 126, 125]`). Pass EVERY row, including ones the
 * adapter doesn't recognise as messages: they still occupy an index, and skipping them would
 * make a real neighbour look like a gap.
 */
export function contiguousPrecedingRun(indices: number[]): ContiguousRun {
  if (indices.length === 0) return { length: 0, endsAtGap: false };

  let last = indices[0]!;
  if (!Number.isFinite(last)) return { length: 0, endsAtGap: true };

  let length = 0;
  for (let i = 1; i < indices.length; i++) {
    const next = indices[i]!;
    if (!Number.isFinite(next) || next !== last - 1) return { length, endsAtGap: true };
    length++;
    last = next;
  }
  return { length, endsAtGap: last > 0 };
}
