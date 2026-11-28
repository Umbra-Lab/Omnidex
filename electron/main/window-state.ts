import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, type BrowserWindow, type Rectangle, screen } from 'electron';

/**
 * Window-state persistence (size + position + maximized), dependency-free.
 *
 * Today BrowserWindow is created with a hardcoded 1280×800 on every launch, so
 * a user who resizes / moves / maximizes the window loses it the next time they
 * open the app. This persists the last geometry to a small JSON in
 * `app.getPath('userData')` and restores it on the next launch — but only after
 * CLAMPING it to a currently-visible display, so a window saved on an
 * since-disconnected external monitor doesn't restore off-screen and become
 * unreachable.
 *
 * Writes are debounced (resize/move fire continuously while dragging) and also
 * flushed on close. The file is intentionally tiny and human-readable; a
 * corrupt/missing file just falls back to defaults.
 */

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

// Defaults match the historical hardcoded values so first-launch is unchanged.
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 1024;
const MIN_HEIGHT = 768;
const SAVE_DEBOUNCE_MS = 400;

const STATE_FILE = 'window-state.json';

function stateFilePath(): string {
  return join(app.getPath('userData'), STATE_FILE);
}

/** Read + validate the persisted state, or null if absent/corrupt/invalid. */
function readState(): WindowState | null {
  try {
    const raw = readFileSync(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    if (
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      !Number.isFinite(parsed.width) ||
      !Number.isFinite(parsed.height)
    ) {
      return null;
    }
    return {
      width: Math.max(MIN_WIDTH, Math.round(parsed.width)),
      height: Math.max(MIN_HEIGHT, Math.round(parsed.height)),
      x:
        typeof parsed.x === 'number' && Number.isFinite(parsed.x)
          ? Math.round(parsed.x)
          : undefined,
      y:
        typeof parsed.y === 'number' && Number.isFinite(parsed.y)
          ? Math.round(parsed.y)
          : undefined,
      isMaximized: parsed.isMaximized === true,
    };
  } catch {
    // Missing file (first launch) or unparseable JSON → use defaults.
    return null;
  }
}

/** Height of the strip that must stay reachable to drag the window. */
const TITLE_BAR_HEIGHT = 32;
/** How much of that strip, horizontally, must be on one display. */
const MIN_VISIBLE_TITLE_WIDTH = 120;

export interface Bounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/**
 * Fit saved bounds to the displays that exist now. Pure, so it is tested
 * without Electron.
 *
 * "Partly on some display" is not enough: a window whose title bar is off
 * screen can't be dragged back, and a 2560×1400 window saved on a desktop
 * monitor, centred on a 1366×728 laptop work area, puts its title bar above
 * the top of the screen. So:
 *
 *   - The window is kept where it was only if its title bar strip has at least
 *     MIN_VISIBLE_TITLE_WIDTH px on one display's work area. It is then shrunk
 *     to that work area and nudged fully inside it.
 *   - Otherwise the position is dropped (Electron centres the window) and the
 *     size is shrunk to the primary display's work area.
 *
 * Never below MIN_WIDTH × MIN_HEIGHT: the BrowserWindow enforces those anyway.
 */
export function fitBounds(
  saved: Bounds,
  workAreas: readonly Rectangle[],
  primaryWorkArea: Rectangle,
): Bounds {
  const fitSize = (wa: Rectangle) => ({
    width: Math.max(MIN_WIDTH, Math.min(saved.width, wa.width)),
    height: Math.max(MIN_HEIGHT, Math.min(saved.height, wa.height)),
  });

  if (saved.x !== undefined && saved.y !== undefined) {
    const { x, y } = saved;
    const home = workAreas.find((wa) => {
      const overlap = Math.min(x + saved.width, wa.x + wa.width) - Math.max(x, wa.x);
      const titleOnScreen = y >= wa.y && y + TITLE_BAR_HEIGHT <= wa.y + wa.height;
      return overlap >= MIN_VISIBLE_TITLE_WIDTH && titleOnScreen;
    });
    if (home) {
      const size = fitSize(home);
      const clamp = (v: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(v, Math.max(lo, hi)));
      return {
        ...size,
        x: clamp(x, home.x, home.x + home.width - size.width),
        y: clamp(y, home.y, home.y + home.height - size.height),
      };
    }
  }
  return fitSize(primaryWorkArea);
}

/**
 * Compute the BrowserWindow constructor options (width/height/x/y) to restore.
 * See `fitBounds` for how saved geometry is fitted to the current displays.
 * Maximized state is applied separately by `manageWindowState` after the window
 * exists (maximize() must be called on the instance, not via the constructor).
 */
export function getWindowBounds(): Bounds {
  const saved = readState();
  if (!saved) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  return fitBounds(
    saved,
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
  );
}

/** True if the saved state had the window maximized (apply post-construction). */
export function shouldStartMaximized(): boolean {
  return readState()?.isMaximized === true;
}

/**
 * Attach resize/move/maximize listeners that persist the window geometry, and
 * apply the saved maximized state. Call once, immediately after createWindow,
 * passing the BrowserWindow. Returns nothing; cleanup is automatic on 'closed'.
 */
export function manageWindowState(win: BrowserWindow): void {
  if (shouldStartMaximized()) {
    win.maximize();
  }

  let saveTimer: NodeJS.Timeout | null = null;

  const persist = (): void => {
    if (win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    // When maximized, getBounds() returns the maximized rect; we want to keep
    // the *normal* (restored) bounds so un-maximizing later lands somewhere
    // sane. getNormalBounds() gives us exactly that.
    const bounds = win.getNormalBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    };
    try {
      writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8');
    } catch {
      // Best-effort: a failed write just means we restore the previous geometry
      // next launch. Never throw from a window event handler.
    }
  };

  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, SAVE_DEBOUNCE_MS);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  // Flush synchronously on close so the final geometry isn't lost to a pending
  // debounce timer that the closing window would otherwise drop.
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    persist();
  });
}
