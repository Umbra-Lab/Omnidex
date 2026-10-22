import { mkdirSync } from 'node:fs';
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
 * The command palette: open, filter, run, dismiss.
 *
 * This spec was written against the Svelte renderer and never updated when it
 * was deleted. It waited on `[data-testid="command-palette"]` and `.palette-row`
 * — markup that died with `CommandPalette.svelte`. The palette itself has worked
 * the whole time; Ctrl+K has always toggled it. Only the test was looking for a
 * component that no longer exists.
 *
 * It now drives accessible roles rather than test ids. The palette is cmdk
 * inside a Radix dialog, so `role="dialog"` (named by the sr-only title),
 * `role="option"` for rows, and the placeholder for the input are all already
 * there — no source change, and no test id that only a test would ever read.
 * The dialog is matched BY NAME because the onboarding modal is also a dialog
 * and opens by itself when the library has no scan locations.
 *
 * Each test now opens the palette itself. The old file leaked state between
 * tests — "typing filters" assumed the previous test had left it open, so one
 * stale selector took all three down, and "ESC closes" passed vacuously the
 * whole time because Playwright's toBeHidden is satisfied by an element that
 * was never in the DOM.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHOTS_DIR = resolve(REPO_ROOT, 'tests', '.shots');
mkdirSync(SHOTS_DIR, { recursive: true });

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  // No OMNIDEX_USER_DATA here. The old spec set it and built a temp dir per
  // run, which read as isolation and was not: nothing under electron/ consumes
  // that variable, and `app.setName('omnidex')` pins every launch to the same
  // real userData dir and SQLite file. Better to be honestly shared than
  // fictionally isolated.
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

/** The palette dialog, by accessible name so the onboarding dialog can't match. */
const palette = () => win.getByRole('dialog', { name: 'Command palette' });

async function openPalette() {
  if (
    await palette()
      .isVisible()
      .catch(() => false)
  )
    return;
  await win.keyboard.press('Control+K');
  await expect(palette()).toBeVisible({ timeout: 3000 });
}

async function closePalette() {
  if (
    !(await palette()
      .isVisible()
      .catch(() => false))
  )
    return;
  await win.keyboard.press('Escape');
  await expect(palette()).toBeHidden({ timeout: 3000 });
}

test.afterEach(async () => {
  await closePalette();
});

test('Ctrl+K opens the command palette', async () => {
  await expect(palette()).toBeHidden();
  await win.keyboard.press('Control+K');
  await expect(palette()).toBeVisible({ timeout: 3000 });

  // Opening it is only useful if it arrives populated.
  await expect(win.getByRole('option').first()).toBeVisible({ timeout: 3000 });
  await win.screenshot({ path: resolve(SHOTS_DIR, 'palette-open.png') });
});

test('typing filters the command list', async () => {
  await openPalette();
  const all = await win.getByRole('option').count();
  expect(all, 'palette should list commands before filtering').toBeGreaterThan(1);

  await win.getByPlaceholder(/Type a command/).fill('collect');
  await expect
    .poll(async () => await win.getByRole('option').count(), { timeout: 3000 })
    .toBeLessThan(all);

  const rows = await win.getByRole('option').allTextContents();
  expect(rows.some((r) => r.toLowerCase().includes('collection'))).toBe(true);
  // Filtering has to EXCLUDE too — matching everything would also pass the
  // assertion above.
  expect(rows.some((r) => r.toLowerCase().includes('refresh library'))).toBe(false);
});

test('a filtered command runs and navigates', async () => {
  await openPalette();
  await win.getByPlaceholder(/Type a command/).fill('collect');
  await win.getByRole('option', { name: /Go to collections/ }).click();

  // Running a command closes the palette and actually goes somewhere.
  await expect(palette()).toBeHidden({ timeout: 3000 });
  await expect
    .poll(async () => await win.evaluate(() => window.location.hash), { timeout: 3000 })
    .toBe('#/collections');
});

test('Escape closes the palette', async () => {
  await openPalette();
  // Assert it is open first — otherwise toBeHidden passes on an absent element
  // and the test proves nothing, which is exactly what it used to do.
  await expect(palette()).toBeVisible();

  await win.keyboard.press('Escape');
  await expect(palette()).toBeHidden({ timeout: 3000 });
});
