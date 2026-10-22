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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = resolve(REPO_ROOT, 'tests', '.shots');
mkdirSync(SHOTS_DIR, { recursive: true });

/**
 * The collapsed information architecture: six nav tabs down to three, plus the
 * Match queue that took the freed slot. Runs against the real library.
 */

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
  await win.setViewportSize({ width: 1600, height: 950 });
  await win
    .locator('[data-testid="asset-card"], [data-testid="asset-row"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test('the nav is three destinations, and prints no duplicate wordmark', async () => {
  const labels = await win.locator('header nav a').allInnerTexts();
  expect(labels).toHaveLength(3);
  expect(labels[0]).toContain('Library');
  expect(labels[1]).toContain('Match');
  expect(labels[2]).toContain('Learn');

  // Projects and FAB are gone, not hidden.
  for (const dead of ['Projects', 'FAB', 'Collections', 'Health']) {
    expect(labels.join(' ')).not.toContain(dead);
  }

  // On Windows/Linux the OS caption already says "Omnidex" one strip up, so
  // the nav must not say it a second time.
  const header = await win.locator('header').innerText();
  expect(header).not.toMatch(/^Omnidex/);
});

test('the Match tab badges the unmatched backlog', async () => {
  const match = win.locator('header nav a').filter({ hasText: 'Match' });
  const text = await match.innerText();
  // Exact count, never compact.
  expect(text).toMatch(/[\d,]+/);
  expect(text).not.toMatch(/\d+(\.\d)?K\b/);
});

test('the Assets grid no longer lists courses', async () => {
  const status = (await win.locator('footer').innerText()).replace(/\n/g, ' ');
  // Packs and courses are separate populations; "shown" must track packs.
  const packs = /([\d,]+) packs/.exec(status)?.[1];
  const shown = /([\d,]+) shown/.exec(status)?.[1];
  expect(packs).toBeDefined();
  expect(shown).toBe(packs);
});

test('Collections and Health moved into the Library sidebar', async () => {
  // innerText returns the CSS-uppercased group headings, so compare folded.
  const sidebar = (await win.locator('nav[aria-label="Asset library"]').innerText()).toLowerCase();
  expect(sidebar).toContain('collections');
  expect(sidebar).toContain('manage collections');
  expect(sidebar).toContain('health');
});

test('the Match queue loads a compare pane and stays inside the window', async () => {
  await win.locator('header nav a').filter({ hasText: 'Match' }).click();
  await win.locator('text=NEEDS MATCH').first().waitFor({ state: 'visible', timeout: 15_000 });
  // Candidate lookup is a live rate-limited Orbital call.
  await win.waitForTimeout(4000);

  const body = await win.locator('main').innerText();
  expect(body).toContain('ON DISK');
  expect(body).toContain('ORBITAL CANDIDATE');
  expect(body).toContain('Accept match');

  // A long marketplace title must truncate inside its pane, not push the
  // layout past the window — `grid-cols-2` defaults to minmax(auto,1fr),
  // which refuses to shrink below content.
  const overflow = await win.evaluate(() => {
    const vw = window.innerWidth;
    const bad = [...document.querySelectorAll<HTMLElement>('main *')].filter(
      (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > vw + 1,
    );
    return { count: bad.length, docScroll: document.documentElement.scrollWidth, vw };
  });
  expect(overflow.count).toBe(0);
  expect(overflow.docScroll).toBeLessThanOrEqual(overflow.vw);

  await win.screenshot({ path: resolve(SHOTS_DIR, 'match-queue.png') });
});
