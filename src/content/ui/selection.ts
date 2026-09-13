// Detects the current text selection and exposes its Range + bounding rect.
// Generic Web Platform API usage — no claude.ai-specific knowledge.

export interface SelectionInfo {
  text: string;
  range: Range;
  rect: DOMRect;
}

export function getCurrentSelectionInfo(): SelectionInfo | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  return { text, range, rect };
}

/** Calls `callback` with the current selection (or null) whenever it changes. Returns an unsubscribe function. */
export function onSelectionChange(callback: (info: SelectionInfo | null) => void): () => void {
  const handler = () => callback(getCurrentSelectionInfo());
  document.addEventListener('selectionchange', handler);
  return () => document.removeEventListener('selectionchange', handler);
}
