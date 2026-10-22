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
 * Learn R3 against the real library.
 *
 * The screen used to be cards holding a folder name and the string "tutorial",
 * whose only verb was "open Windows Explorer". These assert it now knows what
 * is inside a course — and that searching reaches into subtitle cues rather
 * than matching folder names.
 *
 * Requires at least one Courses location to have been scanned since the
 * manifest landed; the tests skip rather than fail if nothing is indexed yet,
 * because an unscanned library is a valid state, not a regression.
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
    .waitFor({ state: 'visible', timeout: 20_000 });
  await win.locator('header nav a').filter({ hasText: 'Learn' }).click();
  await win
    .locator('[data-testid="course-row"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test('a course row carries duration, video count and chapters', async () => {
  const rows = win.locator('[data-testid="course-row"]');
  expect(await rows.count()).toBeGreaterThan(0);

  // At least one course must have a real manifest — otherwise the whole
  // feature is inert and "0 videos" everywhere would pass a weaker assertion.
  const texts = await rows.allInnerTexts();
  const withVideos = texts.filter((t) => /\b[1-9]\d* videos\b/.test(t));
  test.skip(withVideos.length === 0, 'no Courses location scanned since the manifest landed');

  const sample = withVideos[0];
  expect(sample).toMatch(/\d+ videos/);
  // Duration renders as "5h 05m" or "42m", never a bare number of seconds.
  expect(sample).toMatch(/(\d+h \d{2}m|\d+m)/);
  // Exact counts only.
  expect(sample).not.toMatch(/\d+(\.\d)?K\b/);
});

test('selecting a course lists its lessons grouped by chapter', async () => {
  const rows = win.locator('[data-testid="course-row"]');
  const texts = await rows.allInnerTexts();
  const idx = texts.findIndex((t) => /\b[1-9]\d* videos\b/.test(t));
  test.skip(idx === -1, 'no indexed course available');

  await rows.nth(idx).click();
  await win.locator('[data-testid="course-lesson"]').first().waitFor({ timeout: 10_000 });
  expect(await win.locator('[data-testid="course-lesson"]').count()).toBeGreaterThan(0);

  // The old screen's only verb was opening Explorer; there is a play path now.
  await expect(win.getByRole('button', { name: /^(Start|Resume) —/ })).toBeVisible();
});

test('search reaches inside subtitle cues, not just folder names', async () => {
  const box = win.getByPlaceholder('Search inside transcripts…');
  await box.fill('niagara');
  // FTS over ~145k cues, plus the debounce.
  await win.waitForTimeout(2500);

  const banner = win.locator('text=/hits in/').first();
  test.skip((await banner.count()) === 0, 'no transcripts indexed yet');

  const summary = await banner.innerText();
  expect(summary).toMatch(/\d+ hits in \d+ courses/);

  // A hit is a timestamp plus the words that were actually spoken — proof
  // this is cue text and not a filename match.
  const hitPanel = win.locator('text=/Transcript hits for/').first();
  if (await hitPanel.count()) {
    const body = await win.locator('section').last().innerText();
    expect(body.toLowerCase()).toContain('niagara');
    expect(body).toMatch(/\d+:\d{2}/);
  }
  await win.screenshot({ path: resolve(SHOTS_DIR, 'learn-transcript-search.png') });

  await box.fill('');
});

test('the Learn screen stays inside the window', async () => {
  const overflow = await win.evaluate(() => {
    const vw = window.innerWidth;
    const bad = [...document.querySelectorAll<HTMLElement>('main *')].filter(
      (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > vw + 1,
    );
    return { count: bad.length, docScroll: document.documentElement.scrollWidth, vw };
  });
  expect(overflow.count).toBe(0);
  expect(overflow.docScroll).toBeLessThanOrEqual(overflow.vw);
});
