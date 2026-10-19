// Where the popup opens (v10). Below the highlight when there is room, else above it, anchored by
// its bottom edge so a growing thread grows upward, away from the highlight; else (a selection
// taller than the screen) as an overlay at the top. Its height is capped to the room on the chosen
// side, so it is never off screen: a long thread scrolls inside it instead.
// Fixes a v1 bug: `top` used to be clamped to `innerHeight - 40`, so a highlight near the bottom of
// the screen opened a popup that was almost entirely below it. Computed once, at open; the popup
// still does not follow page scroll (v1 limitation). Pure.

export const POPUP_WIDTH = 460;
export const POPUP_MAX_HEIGHT = 600;
export const VIEWPORT_MARGIN = 8;
export const ANCHOR_GAP = 6;
/** Below is preferred whenever it has at least this much room. */
export const PREFER_BELOW_MIN = 320;
/** Less room than this on a side is not worth using; the overlay is used instead. */
export const MIN_USABLE_HEIGHT = 160;

export interface Placement {
  left: number;
  width: number;
  maxHeight: number;
  /** Set when the popup opens below (or as the overlay); null when it opens above. */
  top: number | null;
  /** Distance from the viewport's bottom edge; set only when the popup opens above. */
  bottom: number | null;
}

export function placePopup(
  anchor: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
): Placement {
  const width = Math.min(POPUP_WIDTH, viewport.width - 32);
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, viewport.width - width - VIEWPORT_MARGIN));

  // Clamped to the viewport, so a highlight that runs off screen still gets an on-screen popup.
  const belowTop = Math.max(VIEWPORT_MARGIN, anchor.bottom + ANCHOR_GAP);
  const roomBelow = viewport.height - VIEWPORT_MARGIN - belowTop;
  const aboveEdge = Math.min(viewport.height - VIEWPORT_MARGIN, anchor.top - ANCHOR_GAP);
  const roomAbove = aboveEdge - VIEWPORT_MARGIN;

  if (roomBelow >= PREFER_BELOW_MIN || (roomBelow >= roomAbove && roomBelow >= MIN_USABLE_HEIGHT)) {
    return { left, width, top: belowTop, bottom: null, maxHeight: Math.min(POPUP_MAX_HEIGHT, roomBelow) };
  }
  if (roomAbove >= MIN_USABLE_HEIGHT) {
    return { left, width, top: null, bottom: viewport.height - aboveEdge, maxHeight: Math.min(POPUP_MAX_HEIGHT, roomAbove) };
  }
  return {
    left,
    width,
    top: VIEWPORT_MARGIN,
    bottom: null,
    maxHeight: Math.min(POPUP_MAX_HEIGHT, viewport.height - 2 * VIEWPORT_MARGIN),
  };
}
