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
      x: typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? Math.round(parsed.x) : undefined,
      y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? Math.round(parsed.y) : undefined,
      isMaximized: parsed.isMaximized === true,
    };
  } catch {
    // Missing file (first launch) or unparseable JSON → use defaults.
    return null;
  }
}

/**
 * True if the given window rectangle is at least partially on a connected
 * display. A window restored entirely off the visible work area (monitor
 * unplugged, resolution changed) is unreachable, so we drop its saved position
 * and let Electron center the window instead.
 */
function isRectVisible(rect: Rectangle): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const wa = display.workArea;
    const overlapsX = rect.x < wa.x + wa.width && rect.x + rect.width > wa.x;
    const overlapsY = rect.y < wa.y + wa.height && rect.y + rect.height > wa.y;
    return overlapsX && overlapsY;
  });
}

/**
 * Compute the BrowserWindow constructor options (width/height/x/y) to restore.
 * Position is included only when the saved rectangle is still visible on a
 * connected display; otherwise it's omitted so Electron centers the window.
 * Maximized state is applied separately by `manageWindowState` after the window
 * exists (maximize() must be called on the instance, not via the constructor).
 */
export function getWindowBounds(): {
  width: number;
  height: number;
  x?: number;
  y?: number;
} {
  const saved = readState();
  if (!saved) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  const bounds: { width: number; height: number; x?: number; y?: number } = {
    width: saved.width,
    height: saved.height,
  };
  if (
    saved.x !== undefined &&
    saved.y !== undefined &&
    isRectVisible({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
  ) {
    bounds.x = saved.x;
    bounds.y = saved.y;
  }
  return bounds;
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
