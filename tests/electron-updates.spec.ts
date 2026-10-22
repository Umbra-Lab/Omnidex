import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';

/**
 * Opt-in update checks, end to end through the real window.
 *
 * Playwright launches the unpackaged build, and update checks only run from an
 * installed one, so nothing here can reach GitHub. That is the point of the
 * first test: a development build must say so, and its button must be dead.
 * What this suite can prove is the loop around the network call: the switch
 * persists through the main process, the menu item reaches the About tab, and
 * the card tells the user what a check sends. The check itself (events,
 * download, install) is covered against a mocked electron-updater in
 * `electron/main/__tests__/updater.test.ts`.
 *
 * The suite shares the real userData database, so it restores the switch to
 * whatever it found.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let app: ElectronApplication;
let win: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  app = await electron.launch({
    args: [resolve(REPO_ROOT, 'out', 'main', 'index.mjs')],
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
  win = await app.firstWindow({ timeout: 15_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);
});

test.afterAll(async () => {
  await app?.close();
});

const openAbout = async (): Promise<void> => {
  await win.evaluate(() => {
    window.location.hash = '#/settings/about';
  });
  await expect(win.getByText('Software updates', { exact: true })).toBeVisible({ timeout: 5000 });
};

const autoCheckSwitch = () => win.getByRole('switch', { name: 'Check for updates automatically' });

test('a development build says it cannot check, and its button is disabled', async () => {
  await openAbout();

  await expect(win.getByText('Update checks run only in installed builds')).toBeVisible();
  await expect(win.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  // Nothing to decide, so no banner strip under the nav bar.
  await expect(win.getByText(/is available\.|is ready to install\./)).toHaveCount(0);
});

test('the card states what a check sends before anything is checked', async () => {
  await openAbout();

  await expect(win.getByText('Installed version')).toBeVisible();
  await expect(win.getByText('github.com/Umbra-Lab/Omnidex').first()).toBeVisible();
  await expect(win.getByText(/nothing downloads until you choose Download update/i)).toBeVisible();
  await expect(win.getByText(/Apple Developer ID/)).toBeVisible();
  // The Privacy card carries the same disclosure, in its own words.
  await expect(win.getByText('Update checks → github.com')).toBeVisible();
});

test('the automatic-check switch saves through the main process and says so', async () => {
  test.setTimeout(60_000);
  await openAbout();

  const toggle = autoCheckSwitch();
  const initial = (await toggle.getAttribute('aria-checked')) === 'true';

  try {
    await toggle.click();
    await expect(win.getByText(`Automatic update checks ${initial ? 'off' : 'on'}`)).toBeVisible({
      timeout: 5000,
    });
    await expect(toggle).toHaveAttribute('aria-checked', String(!initial));

    // A reload re-reads it from the database, not from renderer state.
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await openAbout();
    await expect(autoCheckSwitch()).toHaveAttribute('aria-checked', String(!initial));
  } finally {
    const now = (await autoCheckSwitch().getAttribute('aria-checked')) === 'true';
    if (now !== initial) await autoCheckSwitch().click();
    await expect(autoCheckSwitch()).toHaveAttribute('aria-checked', String(initial));
  }
});

test('Check for Updates in the app menu is disabled in development', async () => {
  const enabled = await app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('check-for-updates')?.enabled,
  );
  expect(enabled).toBe(false);
});

test('the menu item opens Settings → About', async () => {
  // Start somewhere else, then run the menu handler directly: a disabled item
  // cannot be clicked, but the handler is what a packaged build runs.
  await win.evaluate(() => {
    window.location.hash = '#/assets';
  });
  await win.waitForTimeout(500);

  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('check-for-updates')?.click();
  });

  await expect(win.getByText('Software updates', { exact: true })).toBeVisible({ timeout: 5000 });
  expect(await win.evaluate(() => window.location.hash)).toBe('#/settings/about');
});

// ---------------------------------------------------------------------------
// The banner. A development build never finds an update, so these tests play
// the main process: they push a state the way `updater.ts` does, with
// webContents.send on the update channel, after real route changes. That is the
// property that matters, because a tRPC subscription opened at startup would
// have been closed by the first navigation and none of these pushes would land.
// ---------------------------------------------------------------------------

const STATE_CHANNEL = 'omnidex:update:state';

type PushedStatus =
  | { phase: 'idle' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number; transferred: number; total: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; during: 'download'; message: string; version: string };

const push = async (status: PushedStatus, supported = true): Promise<void> => {
  const state = {
    supported,
    unsupportedReason: supported ? null : 'Update checks run only in installed builds.',
    currentVersion: '2.0.7',
    autoCheck: false,
    releaseUrl: 'https://github.com/Umbra-Lab/Omnidex/releases/latest',
    status,
  };
  await app.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload);
    },
    { channel: STATE_CHANNEL, payload: state },
  );
};

test('a pushed update reaches the banner after route changes, and every phase offers its actions', async () => {
  test.setTimeout(60_000);
  await win.evaluate(() => {
    window.location.hash = '#/assets';
  });
  await win.waitForTimeout(400);
  await win.evaluate(() => {
    window.location.hash = '#/settings/folders';
  });
  await win.waitForTimeout(400);

  try {
    await push({ phase: 'available', version: '9.9.9' });
    await expect(win.getByText('Omnidex 9.9.9 is available.')).toBeVisible({ timeout: 5000 });
    await expect(win.getByRole('button', { name: 'Download update' }).first()).toBeVisible();
    await expect(win.getByRole('button', { name: 'View release' }).first()).toBeVisible();
    await expect(win.getByRole('button', { name: 'Dismiss' })).toBeVisible();

    await push({
      phase: 'downloading',
      version: '9.9.9',
      percent: 42,
      transferred: 42,
      total: 100,
    });
    await expect(win.getByText('Downloading Omnidex 9.9.9')).toBeVisible();
    await expect(win.getByText('42%').first()).toBeVisible();
    await expect(win.getByRole('progressbar', { name: 'Download progress' })).toBeVisible();

    await push({ phase: 'downloaded', version: '9.9.9' });
    await expect(win.getByText('Omnidex 9.9.9 is ready to install.')).toBeVisible();
    await expect(win.getByRole('button', { name: 'Restart now' }).first()).toBeVisible();

    // Later dismisses the banner and says what happens next.
    await win.getByRole('button', { name: 'Later' }).click();
    await expect(win.getByText('The update installs when you quit Omnidex')).toBeVisible();
    await expect(win.getByText('Omnidex 9.9.9 is ready to install.')).toHaveCount(0);

    await push({
      phase: 'error',
      during: 'download',
      message: 'Code signature did not pass validation',
      version: '9.9.9',
    });
    await expect(
      win.getByText('The download failed. Code signature did not pass validation'),
    ).toBeVisible();
    await expect(win.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(win.getByRole('button', { name: 'View release' }).first()).toBeVisible();
  } finally {
    await push({ phase: 'idle' }, false);
  }
  await expect(win.getByRole('button', { name: 'Dismiss' })).toHaveCount(0);
});

test('Restart now with nothing downloaded says so instead of quitting', async () => {
  try {
    // A different version from the last test, whose dismissal is still remembered.
    await push({ phase: 'downloaded', version: '9.9.8' });
    await win.getByRole('button', { name: 'Restart now' }).first().click();
    await expect(win.getByText('No update is ready to install')).toBeVisible({ timeout: 5000 });
    // The app is still here to assert on.
    await expect(win.getByRole('button', { name: 'Restart now' }).first()).toBeVisible();
  } finally {
    await push({ phase: 'idle' }, false);
  }
});
