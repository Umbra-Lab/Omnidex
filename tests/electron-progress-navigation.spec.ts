import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
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
 * Scan progress keeps reaching the shell after in-app navigation.
 *
 * `ScanProgressPanel` lives in `AppShell` and opens its `progress.onProgress`
 * subscription once, at mount. The renderer uses hash routing, so every route
 * change is a same-document navigation, and electron-trpc used to close every
 * subscription of a frame on `did-start-navigation` without asking whether the
 * navigation kept the document. The subscription was gone after the first route
 * change while the renderer still believed it was listening, so the panel never
 * appeared for any scan started afterwards.
 *
 * The order here is the point: navigate first, scan second. A spec that scans
 * on the initial route passes against the broken build.
 *
 * Like the other specs that register a folder, it works on the real userData
 * library (`app.setName('omnidex')` pins every launch to it), so the folder it
 * adds is removed again in `afterAll`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Unique per run, so a crashed run cannot collide with the next one and the
// cleanup can only ever match the folder this run created.
const RUN_ID = String(process.pid);
const FOLDER_NAME = `E2E Progress Fixture ${RUN_ID}`;
const LIBRARY_PATH = resolve(REPO_ROOT, 'tests', '.fixtures', `progress-${RUN_ID}`);

let app: ElectronApplication;
let win: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const gen = spawnSync(
    process.execPath,
    [resolve(REPO_ROOT, 'scripts', 'gen-test-library.mjs'), LIBRARY_PATH],
    { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 60_000 },
  );
  if (gen.status !== 0) {
    throw new Error(`gen-test-library failed (${gen.status}): ${gen.stderr ?? ''}`);
  }

  app = await electron.launch({
    args: [resolve(REPO_ROOT, 'out', 'main', 'index.mjs')],
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
  win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  // The shell is mounted, and with it the panel's subscription.
  await expect(win.getByRole('link', { name: 'Open settings' })).toBeVisible({ timeout: 15_000 });
});

test.afterAll(async () => {
  try {
    if (win && !win.isClosed()) await removeFolder();
  } catch (e) {
    console.warn(`[cleanup] could not remove "${FOLDER_NAME}": ${(e as Error).message}`);
  }
  await app?.close();
  rmSync(LIBRARY_PATH, { recursive: true, force: true });
});

const goTo = async (hash: string): Promise<void> => {
  await win.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await expect.poll(() => win.evaluate(() => window.location.hash)).toBe(hash);
};

/** Several route changes, none of them Settings, so nothing re-mounts the panel. */
const wanderThroughRoutes = async (): Promise<void> => {
  for (const hash of ['#/collections', '#/learn', '#/assets']) {
    await goTo(hash);
    await win.waitForTimeout(150);
  }
};

const row = () => win.getByLabel(`Index ${FOLDER_NAME}`);
const rowEl = () => win.locator('li').filter({ has: row() });

/** The floating panel `AppShell` mounts: its header reads "Scanning" or "Completed". */
const panel = () => win.getByRole('status').filter({ hasText: /^(Scanning|Completed)/ });

async function removeFolder() {
  await goTo('#/settings/folders');
  if (
    !(await row()
      .isVisible()
      .catch(() => false))
  )
    return;
  await rowEl().getByRole('button', { name: 'More actions' }).click();
  await win.getByRole('menuitem', { name: 'Delete' }).click();
  await win.getByRole('button', { name: 'Remove' }).click();
  await expect(row()).toBeHidden({ timeout: 8000 });
}

test('a scan started after navigating still drives the shell panel', async () => {
  test.setTimeout(90_000);

  await wanderThroughRoutes();
  await goTo('#/settings/folders');

  // Typed, not browsed: "Browse" opens a native OS picker Playwright cannot drive.
  await win.getByRole('button', { name: 'Add folder' }).click();
  const dialog = win.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await win.getByLabel('Folder path').fill(LIBRARY_PATH);
  await win.getByLabel('Display name').fill(FOLDER_NAME);
  await dialog.getByRole('button', { name: 'Add folder' }).click();
  await expect(row()).toBeVisible({ timeout: 10_000 });

  // Saving a folder from Settings does not scan it; the row's button does.
  await rowEl()
    .getByRole('button', { name: /^Scan$/ })
    .click();

  await expect(
    panel(),
    'the shell panel should show the scan; an empty page here means its subscription died on navigation',
  ).toBeVisible({ timeout: 15_000 });
});

test('a later scan, after more route changes, still reaches the panel', async () => {
  test.setTimeout(90_000);

  // Let the first run's panel finish and clear itself.
  await expect(panel()).toBeHidden({ timeout: 30_000 });

  await wanderThroughRoutes();
  await goTo('#/settings/folders');

  const scanBtn = rowEl().getByRole('button', { name: /^Scan$/ });
  await expect(scanBtn).toBeEnabled({ timeout: 15_000 });
  await scanBtn.click();

  await expect(panel()).toBeVisible({ timeout: 15_000 });
});
