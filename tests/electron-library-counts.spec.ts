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
 * The sidebar's aggregate counts actually reach the renderer.
 *
 * This is the surviving half of `electron-audit.spec.ts`, a six-judge scoring
 * harness that was retired with this spec. Four of its six judges drove
 * `window.omnidex.db.*`, a preload bridge deleted when the UI moved to tRPC, so
 * they could only ever fail — but judge 1 asserted the same dead bridge while
 * merely *docking a point* for it, scoring 9 against a pass mark of 7. It went
 * green for months while asserting a false fact, which is worse than failing:
 * a red test gets fixed, a green one gets trusted.
 *
 * Of everything the harness covered, exactly one thing was not covered
 * elsewhere: that `assets.categoryCounts` and `assets.ecosystemCounts` return
 * usable data. Those two procedures drive the Categories and Ecosystems groups
 * — the primary way a 2,799-pack library gets sliced — and nothing else
 * asserted they come back non-empty. Boot, grid, and nav are covered by
 * electron-ia; scan by electron-verify-buttons and electron-real-scan; the
 * inspector by electron-inspector.
 *
 * The assertions are distribution-independent: they check the counts are real
 * positive integers that sum consistently, never specific totals from one
 * person's library.
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

const sidebar = () => win.getByRole('navigation', { name: 'Asset library' });

/** Trailing tabular count on a sidebar row, e.g. "Unreal Engine 2,570" -> 2570. */
function trailingCount(text: string): number | null {
  const m = text.trim().match(/([\d,]+)\s*$/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

async function groupCounts(groupId: string): Promise<number[]> {
  const rows = sidebar().locator(`[aria-labelledby="${groupId}"] button`);
  const texts = await rows.allTextContents();
  return texts.map(trailingCount).filter((n): n is number => n != null);
}

test('the library group reports a real total', async () => {
  await expect(sidebar()).toBeVisible({ timeout: 8000 });

  const all = sidebar().getByRole('button', { name: /All assets/ });
  await expect(all).toBeVisible();

  const total = trailingCount((await all.textContent()) ?? '');
  expect(total, 'All assets row should carry a parseable count').not.toBeNull();
  expect(total).toBeGreaterThan(0);
});

test('ecosystemCounts comes back populated and partitions the library', async () => {
  const counts = await groupCounts('source-group-ecosystems');
  expect(counts.length, 'Ecosystems group should render at least one row').toBeGreaterThan(0);
  for (const n of counts) expect(n).toBeGreaterThan(0);

  // Every pack has exactly one ecosystem (the repo COALESCEs to 'unknown'), so
  // the rows partition the library and must sum to the All-assets total. This
  // is the assertion that catches a proc returning a subset — a count that is
  // merely non-empty could still be silently wrong.
  const total = trailingCount(
    (await sidebar()
      .getByRole('button', { name: /All assets/ })
      .textContent()) ?? '',
  );
  const sum = counts.reduce((a, b) => a + b, 0);
  expect(sum, `ecosystem rows ${counts.join('+')} should sum to the library total`).toBe(total);
});

test('categoryCounts comes back populated', async () => {
  const counts = await groupCounts('source-group-categories');
  expect(counts.length, 'Categories group should render at least one row').toBeGreaterThan(0);
  for (const n of counts) expect(n).toBeGreaterThan(0);

  // Categories are a JSON array per asset, so they overlap and must NOT be
  // expected to sum to the total — asserting that would be wrong. What must
  // hold is that no single category exceeds the library.
  const total = trailingCount(
    (await sidebar()
      .getByRole('button', { name: /All assets/ })
      .textContent()) ?? '',
  );
  for (const n of counts) expect(n).toBeLessThanOrEqual(total as number);
});

test('marketplace facets partition the library', async () => {
  const counts = await groupCounts('source-group-marketplace');
  expect(counts.length, 'Marketplace group should render both facets').toBe(2);

  // Orbital-matched and Unmatched are complements by construction.
  const total = trailingCount(
    (await sidebar()
      .getByRole('button', { name: /All assets/ })
      .textContent()) ?? '',
  );
  expect(counts[0] + counts[1]).toBe(total);
});
