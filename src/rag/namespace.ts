// Page-load namespaces for chat indexes. Pure, unit-tested.
//
// IndexedDB is shared by every tab of a site. A site whose message positions are only valid for
// one page load (ChatGPT, see sites/turnSequence.ts) must not let two tabs of the same chat write
// the same rows, each in its own numbering: that would give chunks in the wrong order and no
// error. So its conversation id is `<chat id>~<page load token>`, each load gets rows of its own,
// and when a load starts it removes the rows of earlier loads of the same chat (they can only be
// stale, or belong to a tab that will simply re-index what it still shows).

export const NAMESPACE_SEPARATOR = '~';

/** `<chat id>~`, the prefix shared by every page load of a chat, or null for a plain conversation id. */
export function namespacePrefix(conversationId: string): string | null {
  const at = conversationId.indexOf(NAMESPACE_SEPARATOR);
  return at > 0 ? conversationId.slice(0, at + 1) : null;
}
