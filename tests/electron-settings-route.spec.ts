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
 * Settings is a route, not a dialog.
 *
 * The behaviours below are exactly the ones a modal cannot have, so they are
 * what "it is a route now" has to mean in practice: every tab has an address,
 * history moves through them, and a link into a tab lands on that tab.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let app: ElectronApplication;
let win: Page;

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

const hash = async (): Promise<string> => await win.evaluate(() => window.location.hash);

const selectedTab = async (): Promise<string> =>
  (await win.locator('[role="tab"][data-state="active"]').innerText()).trim();

test('every settings tab has its own URL, and history moves through them', async () => {
  test.setTimeout(60_000);

  await win.getByRole('link', { name: 'Open settings' }).click();
  await expect(win.getByRole('tab', { name: 'Folders' })).toBeVisible({ timeout: 5000 });
  expect(await hash()).toBe('#/settings/folders');

  await win.getByRole('tab', { name: 'Marketplace' }).click();
  await win.waitForTimeout(400);
  expect(await hash()).toBe('#/settings/marketplace');

  await win.getByRole('tab', { name: 'Storage' }).click();
  await win.waitForTimeout(400);
  expect(await hash()).toBe('#/settings/storage');

  // Back walks the tabs, which is the whole point of them being addresses.
  await win.goBack();
  await win.waitForTimeout(500);
  expect(await hash()).toBe('#/settings/marketplace');
  expect(await selectedTab()).toBe('Marketplace');

  await win.goForward();
  await win.waitForTimeout(500);
  expect(await hash()).toBe('#/settings/storage');
  expect(await selectedTab()).toBe('Storage');
});

test('a deep link opens its tab; a bad one redirects instead of lying', async () => {
  test.setTimeout(60_000);

  // Straight to a tab, the way a "your folders are here" link would.
  await win.evaluate(() => {
    window.location.hash = '#/settings/marketplace';
  });
  await win.waitForTimeout(600);
  expect(await selectedTab()).toBe('Marketplace');

  // Bare /settings has no content of its own.
  await win.evaluate(() => {
    window.location.hash = '#/settings';
  });
  await win.waitForTimeout(600);
  expect(await hash()).toBe('#/settings/folders');
  expect(await selectedTab()).toBe('Folders');

  // An unknown tab rewrites the URL rather than rendering a tab the address
  // bar does not name.
  await win.evaluate(() => {
    window.location.hash = '#/settings/nonsense';
  });
  await win.waitForTimeout(600);
  expect(await hash()).toBe('#/settings/folders');
  expect(await selectedTab()).toBe('Folders');
});

test('leaving settings and coming back is ordinary navigation', async () => {
  test.setTimeout(60_000);

  await win.evaluate(() => {
    window.location.hash = '#/settings/storage';
  });
  await win.waitForTimeout(600);

  // A link out of Settings — no dialog to dismiss first.
  await win.getByRole('link', { name: 'Library' }).click();
  await win.waitForTimeout(600);
  expect(await hash()).toBe('#/assets');

  await win.goBack();
  await win.waitForTimeout(600);
  expect(await hash()).toBe('#/settings/storage');
  expect(await selectedTab()).toBe('Storage');
});
