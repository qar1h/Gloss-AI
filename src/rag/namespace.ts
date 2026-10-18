// Page-load namespaces for chat indexes. Pure, unit-tested.
//
// IndexedDB is shared by every tab of a site. A site whose message positions are only valid for
// one page load (ChatGPT, see sites/turnSequence.ts) must not let two tabs of the same chat write
// the same rows, each in its own numbering: that would give chunks in the wrong order and no
// error. So its conversation id is `<chat id>~<page load token>`, each load gets rows of its own,
// and when a load starts it removes the rows of earlier loads of the same chat (they can only be
// stale, or belong to a tab that will simply re-index what it still shows).

export const NAMESPACE_SEPARATOR = '~';

/**
 * The exclusive upper bound of every key that starts with `prefix`: the prefix with its last
 * character incremented.
 *
 * Do NOT use U+FFFF as the upper bound. It is a Unicode noncharacter: whether it is typed into
 * the source or written as an escape that a bundler may emit raw, it ends up as that character in
 * the built script, and Chrome then refuses to load the whole content script with "It isn't
 * UTF-8 encoded" even though a plain UTF-8 decode of the file succeeds. (That is what happened
 * to v8's first build: the raw character was in store.ts.) scripts/check-build-output.mjs fails
 * the build if one gets through.
 */
export function prefixRangeEnd(prefix: string): string {
  const last = prefix.length - 1;
  return prefix.slice(0, last) + String.fromCharCode(prefix.charCodeAt(last) + 1);
}

/** `<chat id>~`, the prefix shared by every page load of a chat, or null for a plain conversation id. */
export function namespacePrefix(conversationId: string): string | null {
  const at = conversationId.indexOf(NAMESPACE_SEPARATOR);
  return at > 0 ? conversationId.slice(0, at + 1) : null;
}
