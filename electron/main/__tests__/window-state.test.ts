import { describe, expect, it } from 'vitest';
import { fitBounds } from '../window-state';

/**
 * Restoring a saved window onto whatever displays exist now. The failure this
 * guards against is a window the user can't reach: title bar above the top of
 * the screen, or nearly all of it on a monitor that's been unplugged.
 */
const laptop = { x: 0, y: 0, width: 1366, height: 728 };
const desk = { x: 0, y: 0, width: 2560, height: 1400 };
const right = { x: 2560, y: 0, width: 1920, height: 1040 };

describe('fitBounds', () => {
  it('keeps a window that fits where it was', () => {
    expect(fitBounds({ width: 1280, height: 800, x: 100, y: 80 }, [desk], desk)).toEqual({
      width: 1280,
      height: 800,
      x: 100,
      y: 80,
    });
  });

  it('keeps a window on a second monitor', () => {
    expect(fitBounds({ width: 1400, height: 900, x: 2700, y: 50 }, [desk, right], desk)).toEqual({
      width: 1400,
      height: 900,
      x: 2700,
      y: 50,
    });
  });

  it('shrinks a desktop-sized window to a laptop and keeps it inside the screen', () => {
    // Saved maximised-ish on a 1440p monitor, reopened on a 1366x768 laptop.
    const r = fitBounds({ width: 2500, height: 1350, x: 20, y: 10 }, [laptop], laptop);
    expect(r).toEqual({ width: 1366, height: 768, x: 0, y: 0 });
  });

  it('drops the position when the monitor it was on is gone, and fits the primary', () => {
    const r = fitBounds({ width: 1800, height: 1000, x: 2700, y: 50 }, [laptop], laptop);
    expect(r).toEqual({ width: 1366, height: 768 });
  });

  it('drops the position when only a sliver of the window is on screen', () => {
    // Overlaps the display by 40px: "visible", but there's nothing to grab.
    const r = fitBounds({ width: 1280, height: 800, x: 2520, y: 100 }, [desk], desk);
    expect(r.x).toBeUndefined();
    expect(r.y).toBeUndefined();
  });

  it('drops the position when the title bar is above the top of the screen', () => {
    const r = fitBounds({ width: 1280, height: 800, x: 100, y: -200 }, [desk], desk);
    expect(r).toEqual({ width: 1280, height: 800 });
  });

  it('nudges a window hanging off the right edge back inside', () => {
    const r = fitBounds({ width: 1280, height: 800, x: 2000, y: 100 }, [desk], desk);
    expect(r).toEqual({ width: 1280, height: 800, x: 2560 - 1280, y: 100 });
  });

  it('never goes below the window minimum, even on a tiny work area', () => {
    const tiny = { x: 0, y: 0, width: 800, height: 600 };
    expect(fitBounds({ width: 1280, height: 800 }, [tiny], tiny)).toEqual({
      width: 1024,
      height: 768,
    });
  });
});
