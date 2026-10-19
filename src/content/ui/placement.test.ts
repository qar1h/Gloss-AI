import { describe, expect, it } from 'vitest';
import { MIN_USABLE_HEIGHT, VIEWPORT_MARGIN, placePopup } from './placement';

const anchor = (top: number, bottom: number, left = 50) => ({ top, bottom, left });

describe('placePopup', () => {
  it('opens below the highlight when there is room', () => {
    expect(placePopup(anchor(100, 120), { width: 1200, height: 800 })).toEqual({
      left: 50,
      width: 460,
      top: 126,
      bottom: null,
      maxHeight: 600,
    });
  });

  it('v1 bug: a highlight near the bottom of the screen opens the popup above it, fully on screen', () => {
    // v1 clamped top to innerHeight - 40, so this popup was almost entirely off screen.
    expect(placePopup(anchor(740, 760), { width: 1200, height: 800 })).toEqual({
      left: 50,
      width: 460,
      top: null,
      bottom: 66,
      maxHeight: 600,
    });
  });

  it('prefers below when it has at least 320 px, even if above has more', () => {
    const p = placePopup(anchor(400, 420), { width: 1200, height: 800 });
    expect(p.top).toBe(426);
    expect(p.maxHeight).toBe(366);
  });

  it('a selection taller than the screen gets an overlay at the top', () => {
    expect(placePopup(anchor(-100, 900), { width: 1200, height: 800 })).toMatchObject({ top: 8, bottom: null, maxHeight: 600 });
  });

  it('a narrow window narrows the popup and keeps it inside', () => {
    expect(placePopup(anchor(100, 120, 200), { width: 360, height: 800 })).toMatchObject({ width: 328, left: 24 });
    expect(placePopup(anchor(100, 120, 0), { width: 360, height: 800 })).toMatchObject({ left: 8 });
  });

  it('is always fully on screen, wherever the highlight is (even partly off screen)', () => {
    const viewport = { width: 800, height: 600 };
    for (let top = -200; top <= 750; top += 10) {
      for (const height of [16, 60, 300]) {
        const p = placePopup(anchor(top, top + height), viewport);
        const boxTop = p.top ?? viewport.height - (p.bottom ?? 0) - p.maxHeight;
        const boxBottom = boxTop + p.maxHeight;
        expect(boxTop, `top ${top}, height ${height}`).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(boxBottom, `top ${top}, height ${height}`).toBeLessThanOrEqual(viewport.height - VIEWPORT_MARGIN);
        expect(p.maxHeight).toBeGreaterThanOrEqual(MIN_USABLE_HEIGHT);
        expect(p.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(p.left + p.width).toBeLessThanOrEqual(viewport.width - VIEWPORT_MARGIN);
      }
    }
  });
});
