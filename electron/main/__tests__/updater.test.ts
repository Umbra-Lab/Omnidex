import { DatabaseSync } from 'node:sqlite';
import { UPDATE_STATE_CHANNEL } from '@omnidex/types/updates';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The update service against a mocked `electron-updater`.
 *
 * Nothing here touches the network. The fake stands in for the platform updater
 * the way the real one behaves: `checkForUpdates()` emits its events and then
 * settles, and a failure both emits `error` and rejects. Every test gets a
 * fresh copy of `updater.ts` because the service holds module-level state
 * (current status, whether listeners are wired, the launch timer).
 */

type Handler = (...args: unknown[]) => void;

const fake = vi.hoisted(() => {
  const handlers = new Map<string, Handler[]>();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: null as unknown,
    on: vi.fn((event: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
    clearHandlers() {
      handlers.clear();
    },
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };
});
vi.mock('electron-updater', () => ({ default: { autoUpdater: fake } }));

const electronApp = vi.hoisted(() => ({
  isPackaged: true,
  getVersion: () => '2.0.7',
  on: vi.fn(),
}));
const openExternal = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: electronApp, shell: { openExternal } }));

const send = vi.fn();
const fakeWindow = { isDestroyed: () => false, webContents: { send } };
const getWindow = () => fakeWindow as never;

let db: Database;
vi.mock('../db', () => ({ openDatabase: () => db }));

type Service = typeof import('../updater');
type State = Awaited<ReturnType<Service['checkForUpdates']>>;

const FOUR_HOURS = 4 * 60 * 60 * 1000;

function makeDb(autoCheck?: 'true' | 'false' | string): Database {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE app_settings (
    key TEXT PRIMARY KEY, value TEXT, setting_type TEXT, description TEXT,
    created_date TEXT, modified_date TEXT
  )`);
  if (autoCheck !== undefined) {
    d.prepare(
      "INSERT INTO app_settings (key, value, setting_type) VALUES ('updates.auto_check', ?, 'boolean')",
    ).run(autoCheck);
  }
  return d as unknown as Database;
}

const storedAutoCheck = (): string | undefined =>
  (
    db.prepare("SELECT value FROM app_settings WHERE key = 'updates.auto_check'").get() as
      | { value: string }
      | undefined
  )?.value;

/**
 * The real updater emits only after its network round trips, never inside the
 * call that starts the check. The fakes yield first so a test can observe the
 * "checking" phase the way the UI does.
 */
const afterNetwork = () => Promise.resolve();

/** A check that finds `version`, the way electron-updater signals it. */
const foundUpdate = (version: string) =>
  fake.checkForUpdates.mockImplementation(async () => {
    await afterNetwork();
    fake.emit('update-available', { version });
    return { updateInfo: { version } };
  });

const foundNothing = () =>
  fake.checkForUpdates.mockImplementation(async () => {
    await afterNetwork();
    fake.emit('update-not-available', { version: '2.0.7' });
    return { updateInfo: { version: '2.0.7' } };
  });

let svc: Service;
let seen: State['status']['phase'][];

async function load(autoCheck?: string): Promise<void> {
  db = makeDb(autoCheck);
  vi.resetModules();
  svc = await import('../updater');
  seen = [];
  svc.subscribeUpdateState((s) => seen.push(s.status.phase));
}

beforeEach(() => {
  electronApp.isPackaged = true;
  fake.autoDownload = true;
  fake.autoInstallOnAppQuit = false;
  fake.clearHandlers();
  fake.on.mockClear();
  fake.checkForUpdates.mockReset();
  fake.downloadUpdate.mockReset();
  fake.quitAndInstall.mockReset();
  electronApp.on.mockClear();
  openExternal.mockClear();
  send.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a development build', () => {
  beforeEach(() => {
    electronApp.isPackaged = false;
  });

  it('reports itself unsupported, with a reason the UI can show', async () => {
    await load();
    const state = svc.getUpdateState();
    expect(state.supported).toBe(false);
    expect(state.unsupportedReason).toMatch(/installed builds/i);
    expect(state.currentVersion).toBe('2.0.7');
  });

  it('never contacts the updater, even for a manual check', async () => {
    await load('true');
    svc.initAutoUpdater(getWindow);
    const state = await svc.checkForUpdates('manual');

    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    expect(fake.on).not.toHaveBeenCalled();
    expect(state.status).toEqual({ phase: 'idle' });
  });

  it('still saves the preference, so the switch works and survives a restart', async () => {
    await load();
    const state = svc.setAutoCheck(true);
    expect(state.autoCheck).toBe(true);
    expect(storedAutoCheck()).toBe('true');
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe('launch and schedule', () => {
  it('makes no request at launch and none on the timer while the setting is off (the default)', async () => {
    vi.useFakeTimers();
    await load();
    svc.initAutoUpdater(getWindow);
    await vi.advanceTimersByTimeAsync(FOUR_HOURS * 3);

    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    expect(svc.getUpdateState().autoCheck).toBe(false);
    expect(svc.getUpdateState().status).toEqual({ phase: 'idle' });
  });

  it('checks once at launch and again every 4 hours when the setting is on', async () => {
    vi.useFakeTimers();
    await load('true');
    foundNothing();
    svc.initAutoUpdater(getWindow);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FOUR_HOURS - 1);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('re-reads the setting on every tick, so turning it off stops the schedule', async () => {
    vi.useFakeTimers();
    await load('true');
    foundNothing();
    svc.initAutoUpdater(getWindow);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    // Written behind the service's back, the way the generic settings.set can.
    db.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'updates.auto_check'").run();
    await vi.advanceTimersByTimeAsync(FOUR_HOURS * 2);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('treats a garbled stored value as off', async () => {
    vi.useFakeTimers();
    await load('1');
    svc.initAutoUpdater(getWindow);
    await vi.advanceTimersByTimeAsync(FOUR_HOURS);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
  });

  it('clears its timer when the app quits', async () => {
    vi.useFakeTimers();
    await load();
    svc.initAutoUpdater(getWindow);
    expect(electronApp.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
  });
});

describe('setAutoCheck', () => {
  it('turning it on saves the preference and runs one check straight away', async () => {
    await load();
    foundNothing();
    const state = svc.setAutoCheck(true);

    expect(storedAutoCheck()).toBe('true');
    expect(state.autoCheck).toBe(true);
    // The check has started by the time the call returns, so the switch has a
    // visible result instead of waiting for the next launch.
    expect(state.status).toMatchObject({ phase: 'checking', trigger: 'auto' });
    await vi.waitFor(() => expect(svc.getUpdateState().status.phase).toBe('up-to-date'));
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('turning it off saves the preference and makes no request', async () => {
    await load('true');
    const state = svc.setAutoCheck(false);

    expect(storedAutoCheck()).toBe('false');
    expect(state.autoCheck).toBe(false);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
  });

  it('publishes the change, so a second window or tab sees the new switch position', async () => {
    await load();
    const autoChecks: boolean[] = [];
    svc.subscribeUpdateState((s) => autoChecks.push(s.autoCheck));
    svc.setAutoCheck(false);
    expect(autoChecks).toEqual([false]);
  });
});

describe('checkForUpdates', () => {
  it('works with the preference off, because the button press is the consent', async () => {
    await load();
    foundUpdate('2.1.0');
    const state = await svc.checkForUpdates('manual');

    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(state.autoCheck).toBe(false);
    expect(state.status).toEqual({ phase: 'available', version: '2.1.0' });
    expect(seen).toEqual(['checking', 'available']);
  });

  it('turns automatic download off and quit-time install on', async () => {
    await load();
    foundNothing();
    await svc.checkForUpdates('manual');

    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(true);
  });

  it('reports up to date with the time of the check', async () => {
    await load();
    foundNothing();
    const before = Date.now();
    const { status } = await svc.checkForUpdates('manual');

    expect(status).toMatchObject({ phase: 'up-to-date', noReleases: false });
    if (status.phase !== 'up-to-date') throw new Error('unreachable');
    expect(status.checkedAt).toBeGreaterThanOrEqual(before);
  });

  it('treats a repository with no releases as nothing to update to, not as an error', async () => {
    await load();
    fake.checkForUpdates.mockImplementation(async () => {
      await afterNetwork();
      const err = new Error(
        'Cannot download "https://github.com/Umbra-Lab/Omnidex/releases.atom", status 404: Not Found',
      );
      fake.emit('error', err);
      throw err;
    });
    const { status } = await svc.checkForUpdates('manual');

    expect(status).toMatchObject({ phase: 'up-to-date', noReleases: true });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports a network failure once, as one line, without a stack', async () => {
    await load();
    fake.checkForUpdates.mockImplementation(async () => {
      const err = new Error('net::ERR_INTERNET_DISCONNECTED\n    at ClientRequest.<anonymous>');
      fake.emit('error', err);
      throw err;
    });
    const { status } = await svc.checkForUpdates('manual');

    expect(status).toEqual({
      phase: 'error',
      during: 'check',
      message: 'net::ERR_INTERNET_DISCONNECTED',
      version: null,
    });
    // The event and the rejection are the same failure: one transition, not two.
    expect(seen).toEqual(['checking', 'error']);
  });

  it('reports a rejection that arrived without an error event', async () => {
    await load();
    fake.checkForUpdates.mockRejectedValue(new Error('socket hang up'));
    const { status } = await svc.checkForUpdates('manual');

    expect(status).toMatchObject({ phase: 'error', during: 'check', message: 'socket hang up' });
  });

  it('reports an inactive updater (null result) instead of spinning forever', async () => {
    await load();
    fake.checkForUpdates.mockResolvedValue(null);
    const { status } = await svc.checkForUpdates('manual');

    expect(status).toMatchObject({
      phase: 'error',
      during: 'check',
      message: 'This build cannot check for updates.',
    });
  });

  it('never leaves the phase on "checking" when a check settles without an event', async () => {
    await load();
    fake.checkForUpdates.mockResolvedValue({ updateInfo: { version: '2.0.7' } });
    const { status } = await svc.checkForUpdates('manual');

    expect(status.phase).toBe('error');
  });

  it('runs one check at a time', async () => {
    await load();
    let release: () => void = () => undefined;
    fake.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            fake.emit('update-not-available', {});
            resolve({});
          };
        }),
    );

    const first = svc.checkForUpdates('manual');
    const second = await svc.checkForUpdates('auto');
    expect(second.status).toMatchObject({ phase: 'checking', trigger: 'manual' });
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(svc.getUpdateState().status.phase).toBe('up-to-date');
  });

  it('can check again after an error', async () => {
    await load();
    fake.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await svc.checkForUpdates('manual');
    expect(svc.getUpdateState().status.phase).toBe('error');

    foundNothing();
    const { status } = await svc.checkForUpdates('manual');
    expect(status.phase).toBe('up-to-date');
  });
});

describe('download and install', () => {
  async function toAvailable(): Promise<void> {
    await load();
    foundUpdate('2.1.0');
    await svc.checkForUpdates('manual');
    fake.downloadUpdate.mockResolvedValue(['installer.exe']);
  }

  it('downloads only after an explicit request, and reports progress in whole percents', async () => {
    await toAvailable();
    expect(fake.downloadUpdate).not.toHaveBeenCalled();

    const started = await svc.downloadUpdate();
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(started.status).toMatchObject({ phase: 'downloading', version: '2.1.0', percent: 0 });

    fake.emit('download-progress', { percent: 12.4, transferred: 12, total: 100 });
    fake.emit('download-progress', { percent: 12.9, transferred: 13, total: 100 });
    fake.emit('download-progress', { percent: 50, transferred: 50, total: 100 });
    expect(svc.getUpdateState().status).toMatchObject({ phase: 'downloading', percent: 50 });
    // Publishes: the start (0%), then 12%, 13% and 50%. 12.4 and 12.9 round to
    // different whole percents, so both count; a repeat of the same one would not.
    expect(seen.filter((p) => p === 'downloading')).toHaveLength(4);
  });

  it('moves to downloaded, and installs only from there', async () => {
    await toAvailable();
    expect(svc.installUpdate()).toBe(false);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    await svc.downloadUpdate();
    expect(svc.installUpdate()).toBe(false);

    fake.emit('update-downloaded', { version: '2.1.0' });
    expect(svc.getUpdateState().status).toEqual({ phase: 'downloaded', version: '2.1.0' });

    expect(svc.installUpdate()).toBe(true);
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('leaves "Later" alone: the update stays downloaded and installs at quit', async () => {
    await toAvailable();
    await svc.downloadUpdate();
    fake.emit('update-downloaded', { version: '2.1.0' });

    expect(svc.getUpdateState().status.phase).toBe('downloaded');
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not restart a download or clobber a downloaded update with a new check', async () => {
    await toAvailable();
    await svc.downloadUpdate();
    await svc.checkForUpdates('auto');
    expect(svc.getUpdateState().status.phase).toBe('downloading');

    fake.emit('update-downloaded', { version: '2.1.0' });
    await svc.checkForUpdates('auto');
    expect(svc.getUpdateState().status.phase).toBe('downloaded');
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('refuses to download when no update was found', async () => {
    await load();
    const state = await svc.downloadUpdate();

    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    expect(state.status).toEqual({ phase: 'idle' });
  });

  it('reports a failed download (an unsigned macOS build) and lets the user try again', async () => {
    await toAvailable();
    fake.downloadUpdate.mockImplementationOnce(async () => {
      await afterNetwork();
      const err = new Error(
        'Code signature at URL file:///Users/x/update.zip did not pass validation\n  stack…',
      );
      fake.emit('error', err);
      throw err;
    });
    await svc.downloadUpdate();
    await vi.waitFor(() => expect(svc.getUpdateState().status.phase).toBe('error'));

    expect(svc.getUpdateState().status).toEqual({
      phase: 'error',
      during: 'download',
      message: 'Code signature at URL file:///Users/x/update.zip did not pass validation',
      version: '2.1.0',
    });

    const retry = await svc.downloadUpdate();
    expect(retry.status).toMatchObject({ phase: 'downloading', version: '2.1.0' });
    expect(fake.downloadUpdate).toHaveBeenCalledTimes(2);
  });

  it('reports a download that rejects without an error event', async () => {
    await toAvailable();
    fake.downloadUpdate.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await svc.downloadUpdate();
    await vi.waitFor(() =>
      expect(svc.getUpdateState().status).toMatchObject({
        phase: 'error',
        during: 'download',
        message: 'ETIMEDOUT',
      }),
    );
  });
});

describe('pushing state to the window', () => {
  const phasesSent = () =>
    send.mock.calls.map(([, state]) => (state as { status: { phase: string } }).status.phase);

  it('sends every state change on the update channel', async () => {
    await load();
    svc.initAutoUpdater(getWindow);
    foundUpdate('2.1.0');
    await svc.checkForUpdates('manual');

    expect(send.mock.calls.every(([channel]) => channel === UPDATE_STATE_CHANNEL)).toBe(true);
    expect(phasesSent()).toEqual(['checking', 'available']);
    expect(send.mock.lastCall?.[1]).toMatchObject({
      status: { phase: 'available', version: '2.1.0' },
      currentVersion: '2.0.7',
    });
  });

  it('reaches the window in a development build too, so the switch stays in step', async () => {
    electronApp.isPackaged = false;
    await load();
    svc.initAutoUpdater(getWindow);
    svc.setAutoCheck(true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.lastCall?.[1]).toMatchObject({ supported: false, autoCheck: true });
  });

  it('sends nothing when there is no window or it is already destroyed', async () => {
    await load();
    svc.initAutoUpdater(() => null);
    svc.setAutoCheck(false);
    expect(send).not.toHaveBeenCalled();

    await load();
    svc.initAutoUpdater(() => ({ ...fakeWindow, isDestroyed: () => true }) as never);
    svc.setAutoCheck(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('state snapshots', () => {
  it('always carries the release page, so "View release" needs no hard-coded URL', async () => {
    await load();
    expect(svc.getUpdateState().releaseUrl).toBe(
      'https://github.com/Umbra-Lab/Omnidex/releases/latest',
    );
  });

  it('stops notifying after unsubscribe', async () => {
    await load();
    const calls: string[] = [];
    const off = svc.subscribeUpdateState((s) => calls.push(s.status.phase));
    foundNothing();
    await svc.checkForUpdates('manual');
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    off();
    await svc.checkForUpdates('manual');
    expect(calls).toHaveLength(afterFirst);
  });
});
