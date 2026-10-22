import { UPDATE_STATE_CHANNEL } from '@omnidex/types/updates';
import { app, type BrowserWindow } from 'electron';
// electron-updater is CJS; named imports break in ESM, so default-import it.
import electronUpdater from 'electron-updater';
import { openDatabase } from './db';
import { readUpdateSettings, writeUpdateSettings } from './updates/settings';
import {
  INITIAL_UPDATE_STATUS,
  isNoReleasesError,
  reduceUpdateStatus,
  summarizeError,
  type UpdateEvent,
  type UpdateStatus,
  type UpdateTrigger,
} from './updates/state';

/**
 * `autoUpdater` is a lazy getter that constructs the platform updater and
 * requires the real `electron` module on first read. Reading it at import time
 * would make every module that reaches this file (the tRPC router, so every
 * router test) need an Electron binary, so it is read only when a packaged
 * build first needs it.
 */
function updater() {
  return electronUpdater.autoUpdater;
}

/**
 * Update checks, opt-in.
 *
 * Nothing here contacts GitHub until the user asks: the "Check for updates"
 * button (Settings → About, or the app menu) runs one check, and the
 * `updates.auto_check` setting, which defaults to OFF, adds a check at launch
 * and every 4 hours. A download starts only from an explicit "Download update".
 * PRIVACY.md and Settings → About describe exactly this; change them together.
 *
 * This is a delivery path, not a working release channel. electron-updater on
 * macOS can only APPLY an update when the running app is signed with a
 * Developer ID and notarized, and current macOS builds are not. Until they are,
 * a macOS download fails with a signature error, which the UI reports and
 * answers with "View release". See docs/devbook/src/subsystems/updates.md for
 * what has to exist before this can be turned on for real.
 */

// Keep in step with build.publish in package.json.
const RELEASES_URL = 'https://github.com/Umbra-Lab/Omnidex/releases';

const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface UpdateState {
  /** False in development builds; checks only run from an installed app. */
  supported: boolean;
  unsupportedReason: string | null;
  currentVersion: string;
  autoCheck: boolean;
  /** Where "View release" goes. */
  releaseUrl: string;
  status: UpdateStatus;
}

type Listener = (state: UpdateState) => void;

let status: UpdateStatus = INITIAL_UPDATE_STATUS;
let wired = false;
let intervalHandle: NodeJS.Timeout | null = null;
const listeners = new Set<Listener>();

export function getUpdateState(): UpdateState {
  const supported = app.isPackaged;
  return {
    supported,
    unsupportedReason: supported
      ? null
      : 'Update checks run only in installed builds, not in development.',
    currentVersion: app.getVersion(),
    autoCheck: readUpdateSettings(openDatabase()).autoCheck,
    releaseUrl: `${RELEASES_URL}/latest`,
    status,
  };
}

/** Subscribe to every state change. Returns the unsubscribe function. */
export function subscribeUpdateState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Read `status` through a call so TypeScript does not carry a narrowing from
 * before an `await` (or an `apply`) across code that has since changed it.
 */
function currentPhase(): UpdateStatus['phase'] {
  return status.phase;
}

function apply(event: UpdateEvent): void {
  const next = reduceUpdateStatus(status, event);
  if (next === status) return;
  status = next;
  publish();
}

function publish(): void {
  const snapshot = getUpdateState();
  for (const listener of listeners) listener(snapshot);
}

function handleError(err: unknown): void {
  if (status.phase === 'checking' && isNoReleasesError(err)) {
    console.log('[updater] no releases published yet');
    apply({ type: 'no-releases', at: Date.now() });
    return;
  }
  const message = summarizeError(err);
  console.error('[updater] error:', message);
  apply({ type: 'failed', message });
}

/** Attach electron-updater listeners once, on the first action that needs them. */
function wire(): void {
  if (wired) return;
  wired = true;
  const u = updater();

  // The user decides when a download starts, and on macOS an unsigned build
  // cannot install one anyway, so nothing downloads in the background.
  u.autoDownload = false;
  u.autoInstallOnAppQuit = true;
  // Replace electron-updater's default console.{log,error} logger, which dumps
  // a stack trace and the full GitHub response headers for a benign 404.
  u.logger = {
    info: (m) => console.log('[updater]', m),
    warn: (m) => {
      if (!isNoReleasesError(m)) console.warn('[updater]', m);
    },
    error: (m) => {
      if (!isNoReleasesError(m)) console.error('[updater]', summarizeError(m));
    },
    debug: () => {},
  };

  u.on('error', handleError);
  u.on('checking-for-update', () => {
    console.log('[updater] checking for updates');
  });
  u.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`);
    apply({ type: 'update-available', version: info.version });
  });
  u.on('update-not-available', () => {
    console.log('[updater] up to date');
    apply({ type: 'update-not-available', at: Date.now() });
  });
  u.on('download-progress', (p) => {
    apply({
      type: 'download-progress',
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
    });
  });
  u.on('update-downloaded', (info) => {
    console.log(`[updater] downloaded ${info.version}`);
    apply({ type: 'update-downloaded', version: info.version });
  });
}

/**
 * Run one check. Resolves with the state after the check settles. A development
 * build, or a check already running or already past it, returns the current
 * state without touching the network.
 */
export async function checkForUpdates(trigger: UpdateTrigger): Promise<UpdateState> {
  if (!app.isPackaged) return getUpdateState();
  if (
    status.phase === 'checking' ||
    status.phase === 'downloading' ||
    status.phase === 'downloaded'
  ) {
    return getUpdateState();
  }

  wire();
  apply({ type: 'check-started', trigger });
  try {
    const result = await updater().checkForUpdates();
    // null means the updater is inactive for this build; no events fire.
    if (result === null) apply({ type: 'failed', message: 'This build cannot check for updates.' });
  } catch (e) {
    // checkForUpdates rejects in addition to emitting 'error'; the event
    // handler already moved the phase, so this only catches a silent reject.
    if (currentPhase() === 'checking') handleError(e);
  }
  // Safety net: never leave the UI spinning on a check that produced no event.
  if (currentPhase() === 'checking') {
    apply({ type: 'failed', message: 'The update check ended without a result.' });
  }
  return getUpdateState();
}

/**
 * Start downloading the release found by the last check. Resolves as soon as the
 * download has started; progress and completion arrive through the state
 * subscription.
 */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) return getUpdateState();
  const retryable = status.phase === 'error' && status.during === 'download';
  if (status.phase !== 'available' && !retryable) return getUpdateState();

  apply({ type: 'download-started' });
  updater()
    .downloadUpdate()
    .catch((e: unknown) => {
      if (status.phase === 'downloading') handleError(e);
    });
  return getUpdateState();
}

/**
 * Quit and install a downloaded update. Returns false when nothing is ready.
 * "Later" needs no call: `autoInstallOnAppQuit` applies it on the next quit.
 */
export function installUpdate(): boolean {
  if (status.phase !== 'downloaded') return false;
  updater().quitAndInstall(true, true);
  return true;
}

/**
 * Persist the automatic-check preference. Turning it on runs one check straight
 * away, so the switch has a visible result instead of waiting for the next
 * launch. Turning it off stops the schedule; a check already in flight finishes.
 */
export function setAutoCheck(enabled: boolean): UpdateState {
  writeUpdateSettings(openDatabase(), { autoCheck: enabled });
  console.log(`[updater] automatic checks ${enabled ? 'on' : 'off'}`);
  publish();
  if (enabled) void checkForUpdates('auto');
  return getUpdateState();
}

/**
 * Push every state change to the window as a plain IPC event. See
 * `UPDATE_STATE_CHANNEL` for why this is not a tRPC subscription.
 */
function forwardStateToWindow(getMainWindow: () => BrowserWindow | null): void {
  subscribeUpdateState((state) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(UPDATE_STATE_CHANNEL, state);
  });
}

/**
 * Called once at app-ready. State changes reach the window in every build, so
 * the preference switch works in development too. Development builds do nothing
 * else. An installed build with the preference off does nothing more either: no
 * timer fires a request and no request is made at launch.
 */
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  forwardStateToWindow(getMainWindow);

  if (!app.isPackaged) {
    console.log('[updater] dev build — update checks disabled');
    return;
  }

  // The timer is armed regardless of the preference and re-reads it each tick,
  // so a change made through the generic settings.set procedure is honored too.
  intervalHandle = setInterval(() => {
    if (readUpdateSettings(openDatabase()).autoCheck) void checkForUpdates('auto');
  }, UPDATE_INTERVAL_MS);
  intervalHandle.unref();
  app.on('before-quit', () => {
    if (intervalHandle) clearInterval(intervalHandle);
  });

  if (readUpdateSettings(openDatabase()).autoCheck) {
    console.log('[updater] automatic checks on — checking at launch');
    void checkForUpdates('auto');
  } else {
    console.log('[updater] automatic checks off (opt-in); no request at launch');
  }
}
