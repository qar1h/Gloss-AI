// Detects the current text selection and exposes its Range + bounding rect.
// Generic Web Platform API usage — no claude.ai-specific knowledge.
//
// A selection that touches our own UI (the popup, the Explain button) is ignored (v10). Probed in
// Chrome 155: a selection made inside our shadow root is reported collapsed at the host's parent,
// so it is ignored anyway; but a drag that starts in the page and ends in the popup is a real
// selection whose focus node is the host element, and its text runs from the drag start to the end
// of <body>. Without this, that brought up Explain, and a click replaced the popup (and its thread).

export interface SelectionInfo {
  text: string;
  range: Range;
  rect: DOMRect;
}

/** True when `node` is one of `hosts`, inside one, or inside a shadow root hosted (at any depth) by one. */
export function isInsideHosts(node: Node | null, hosts: readonly Node[]): boolean {
  let current: Node | null = node;
  while (current) {
    const here = current;
    if (hosts.some((host) => host === here || host.contains(here))) return true;
    const root = here.getRootNode();
    const shadowHost = (root as Partial<ShadowRoot>).host;
    current = root !== here && shadowHost ? shadowHost : null;
  }
  return false;
}

export function getCurrentSelectionInfo(ignoreHosts: readonly Node[] = []): SelectionInfo | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (isInsideHosts(selection.anchorNode, ignoreHosts) || isInsideHosts(selection.focusNode, ignoreHosts)) return null;

  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  return { text, range, rect };
}

/**
 * Calls `callback` with the current selection (or null) whenever it changes. Selections touching
 * any node `ignoreHosts()` returns are reported as null. Returns an unsubscribe function.
 */
export function onSelectionChange(
  callback: (info: SelectionInfo | null) => void,
  ignoreHosts: () => readonly Node[] = () => [],
): () => void {
  const handler = () => callback(getCurrentSelectionInfo(ignoreHosts()));
  document.addEventListener('selectionchange', handler);
  return () => document.removeEventListener('selectionchange', handler);
}
