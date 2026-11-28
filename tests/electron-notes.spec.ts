import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Inspector notes against the real library.
 *
 * The notes editor autosaves on a 600ms debounce. These pin two failures:
 * an edit lost when the panel unmounted before the debounce fired, and one
 * asset's draft showing (and being saved) on the next asset while that
 * asset's note was still loading. This runs against the real library, so
 * each test records the notes it will touch and puts them back.
 */

let app: ElectronApplication;
let win: Page;

const CARD = '[data-testid="asset-card"]';
const NOTE = 'textarea[placeholder="Add a private note for this asset…"]';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  app = await electron.launch({
    args: [resolve(REPO_ROOT, 'out', 'main', 'index.mjs')],
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
  win = await app.firstWindow({ timeout: 15_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1600, height: 950 });
  await win.evaluate(() => {
    location.hash = '#/assets';
  });
  await win.locator(CARD).nth(1).waitFor({ state: 'visible', timeout: 20_000 });
});

test.afterAll(async () => {
  await app?.close();
});

async function openCard(index: number) {
  await win.locator(CARD).nth(index).click();
  await expect(win.locator(NOTE)).toBeEnabled({ timeout: 5000 });
}

async function readNote(index: number): Promise<string> {
  await openCard(index);
  return await win.locator(NOTE).inputValue();
}

async function restoreNote(index: number, original: string) {
  await openCard(index);
  await win.locator(NOTE).fill(original);
  await win.locator(NOTE).blur();
  await expect(win.locator(NOTE)).toHaveValue(original);
  await win.waitForTimeout(300);
}

test('an edit survives leaving the screen before the autosave fires', async () => {
  const marker = `note-${Date.now()}`;
  const original = await readNote(0);
  await win.locator(NOTE).fill(marker);
  // Navigate away at once, inside the 600ms debounce, as the app menu does.
  // (Typing keeps the app's own shortcuts off.)
  await win.evaluate(() => {
    location.hash = '#/collections';
  });
  await expect.poll(() => win.evaluate(() => location.hash)).toContain('collections');

  await win.evaluate(() => {
    location.hash = '#/assets';
  });
  await win.locator(CARD).first().waitFor({ state: 'visible' });
  await openCard(0);
  await expect(win.locator(NOTE)).toHaveValue(marker);

  await restoreNote(0, original);
});

test("one asset's note never shows on, or saves to, the next", async () => {
  const marker = `only-first-${Date.now()}`;
  const original = await readNote(0);
  await win.locator(NOTE).fill(marker);
  await win.locator(NOTE).blur();
  await win.waitForTimeout(300);

  await openCard(1);
  await expect(win.locator(NOTE)).not.toHaveValue(marker);

  await restoreNote(0, original);
});
