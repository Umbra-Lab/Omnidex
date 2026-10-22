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
 * Live check of the toolbar FTS5 search wiring (AssetToolbar search box →
 * `assets.search` FTS5/BM25 → the virtualized AssetGrid). Runs against the real
 * userData library, so the query token is derived from an actual on-screen asset
 * rather than hard-coded. The load-bearing assertions are ranking-independent:
 *
 *   - a real token switches the grid into search mode (the "Relevance" ordering
 *     indicator appears) and returns at least one card;
 *   - a token that can't match anything falls to the search-aware empty state
 *     ("No matches for …") with zero cards — proving the FTS path actually
 *     filters rather than always echoing the full grid;
 *   - clearing the box restores browse mode (the sort control returns).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHOTS_DIR = resolve(REPO_ROOT, 'tests', '.shots');
mkdirSync(SHOTS_DIR, { recursive: true });

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
  app.process().stdout?.on('data', (c: Buffer) => {
    for (const l of c.toString('utf8').split('\n')) if (l.trim()) console.log(`[main] ${l}`);
  });
  await win.waitForTimeout(1500);
});

test.afterAll(async () => {
  await app?.close();
});

test('toolbar search drives FTS5 results and empties on no match', async () => {
  test.setTimeout(60_000);

  // Default route ("/") is the asset grid — no navigation needed.
  const firstCard = win.locator('[data-asset-id]').first();
  await expect(firstCard, 'the library grid should render at least one asset').toBeVisible({
    timeout: 8000,
  });

  // Derive a real, indexable token from the first card's display name.
  const title = (await firstCard.locator('h3').first().textContent())?.trim() ?? '';
  const token = title
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length)[0];
  console.log(`[test] first card title="${title}" → token="${token}"`);
  expect(token, 'need a ≥4-char token from the first asset name to search').toBeTruthy();

  const box = win.getByRole('textbox', { name: 'Search assets' });
  await expect(box).toBeVisible({ timeout: 4000 });
  await box.fill(token as string);
  // Debounce (200ms) + FTS query + render.
  await win.waitForTimeout(1200);

  // The ordering indicator only renders in FTS search mode — proves the wiring.
  await expect(win.getByText('Relevance', { exact: true })).toBeVisible({ timeout: 4000 });
  const hits = await win.locator('[data-asset-id]').count();
  console.log(`[test] "${token}" → ${hits} result card(s)`);
  expect(hits).toBeGreaterThan(0);

  // Soft signal that ranking surfaced the matching asset (not asserted hard:
  // a higher-BM25 match in a non-title field could outrank it off-screen).
  const titles = await win.locator('[data-asset-id] h3').allTextContents();
  const hasToken = titles.some((t) => t.toLowerCase().includes((token as string).toLowerCase()));
  console.log(
    `[test] visible result contains token? ${hasToken} — sample: ${titles.slice(0, 4).join(' | ')}`,
  );
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-fts-search.png') });

  // A token that can't match anything must fall to the search-aware empty state.
  await box.fill('zzqxjkwvqp');
  await win.waitForTimeout(1200);
  await expect(win.getByText(/No matches for/i)).toBeVisible({ timeout: 4000 });
  expect(await win.locator('[data-asset-id]').count()).toBe(0);

  // Clearing the box restores browse mode (sort control back, grid repopulated).
  await win.getByRole('button', { name: 'Clear search' }).click();
  await win.waitForTimeout(800);
  await expect(win.getByText('Relevance', { exact: true })).toHaveCount(0);
  await expect(win.locator('[data-asset-id]').first()).toBeVisible({ timeout: 4000 });
});
