import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
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
 * Add a folder, scan it, see the packs — through the UI a user actually has.
 *
 * The previous version drove `window.omnidex.db.scanLocations`, an IPC surface
 * deleted when the renderer moved to tRPC, so every test in it threw on
 * `undefined`. It was also pinned to `E:/UE Graveyard/throwaway assets` and to
 * counts from one person's drive, so even repaired it could only pass on the
 * machine it was written on.
 *
 * Two things changed. It generates its own corpus with
 * `scripts/gen-test-library.mjs`, so the assertions are about *this* folder
 * rather than whatever else happens to be indexed. And it removes the folder it
 * added: `app.setName('omnidex')` pins every launch to the real userData DB, so
 * a spec that registers a scan location is writing to the user's actual
 * library, and leaving it behind would add a phantom folder to their Settings
 * on every run.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHOTS_DIR = resolve(REPO_ROOT, 'tests', '.shots');
mkdirSync(SHOTS_DIR, { recursive: true });

// Unique per run, so a crashed run cannot collide with the next one and the
// cleanup can only ever match the folder this run created.
const RUN_ID = String(process.pid);
const FOLDER_NAME = `E2E Scan Fixture ${RUN_ID}`;
const LIBRARY_PATH = resolve(REPO_ROOT, 'tests', '.fixtures', `scan-${RUN_ID}`);

let app: ElectronApplication;
let win: Page;
const consoleErrors: string[] = [];

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
  win = await app.firstWindow({ timeout: 15_000 });
  win.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  app.process().stdout?.on('data', (c: Buffer) => {
    for (const l of c.toString('utf8').split('\n')) if (l.trim()) console.log(`[main] ${l}`);
  });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);
});

test.afterAll(async () => {
  // Remove the scan location before closing, so even a run that failed halfway
  // still tidies up the user's real library.
  try {
    if (win && !win.isClosed()) await removeFolder();
  } catch (e) {
    console.warn(`[cleanup] could not remove "${FOLDER_NAME}": ${(e as Error).message}`);
  }
  await app?.close();
  rmSync(LIBRARY_PATH, { recursive: true, force: true });
});

async function openFoldersTab() {
  await win.evaluate(() => {
    window.location.hash = '#/settings/folders';
  });
  await expect(win.getByRole('tab', { name: 'Folders' })).toBeVisible({ timeout: 8000 });
}

/** The per-row indexing switch — `aria-label={`Index ${name}`}` is the only unique row handle. */
const row = () => win.getByLabel(`Index ${FOLDER_NAME}`);
const rowEl = () => win.locator('li').filter({ has: row() });

async function removeFolder() {
  await openFoldersTab();
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

test('adding a folder through Settings registers it', async () => {
  await openFoldersTab();

  // "Add folder" is also the submit label inside the dialog, so open it while
  // the dialog is closed and scope the submit click to the dialog.
  await win.getByRole('button', { name: 'Add folder' }).click();
  const dialog = win.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Typed, not browsed: "Browse" opens a native OS picker Playwright cannot drive.
  await win.getByLabel('Folder path').fill(LIBRARY_PATH);
  await win.getByLabel('Display name').fill(FOLDER_NAME);
  await dialog.getByRole('button', { name: 'Add folder' }).click();

  await expect(row(), 'the new folder should appear in the list').toBeVisible({ timeout: 10_000 });
  await win.screenshot({ path: resolve(SHOTS_DIR, 'real-scan-registered.png') });
});

test('scanning that folder indexes its packs', async () => {
  await openFoldersTab();

  // Adding a folder already kicks a scan, so this may be a re-scan of a folder
  // that finished during the previous test. Either way the row must settle on a
  // real asset count.
  const scanBtn = rowEl().getByRole('button', { name: /^(Scan|Scanning…)$/ });
  if (await scanBtn.isEnabled().catch(() => false)) await scanBtn.click();

  await expect
    .poll(
      async () => {
        const text = (await rowEl().textContent()) ?? '';
        const m = text.match(/([\d,]+)\s+assets?/);
        return m ? Number(m[1].replace(/,/g, '')) : 0;
      },
      { timeout: 90_000, message: 'scan should index the generated packs' },
    )
    .toBeGreaterThan(0);

  await win.screenshot({ path: resolve(SHOTS_DIR, 'real-scan-complete.png') });
});

test('the scan produced no console errors', async () => {
  // Drop the Electron CSP dev warning: the shell emits it on every unpackaged
  // launch and it says nothing about this scan.
  const real = consoleErrors.filter((e) => !/Content-Security-Policy/i.test(e));
  expect(real, `console errors during scan:\n${real.join('\n')}`).toEqual([]);
});
