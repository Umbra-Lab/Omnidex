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
 * Live check of the sidebar Marketplace facets (SourceList "Orbital matched" /
 * "Unmatched" → `match_status` filter on `assets.listCards`, counts from
 * `assets.marketplaceSourceCounts`). Runs against the real userData library.
 *
 * The load-bearing assertion is data-distribution-independent: the two facets
 * must partition the library, so their visible result sets are DISJOINT. A
 * broken filter (showing everything regardless of facet) would make the two
 * sets identical, which this catches.
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

/** The sidebar. Chips carry the same facet names, so scope every row lookup. */
const sidebar = () => win.getByRole('navigation', { name: 'Asset library' });

/**
 * The status bar's authoritative match count. NOT the number of rendered
 * cards: the grid is virtualized, so counting [data-asset-id] measures the
 * viewport (~60 rows) and two different result sets both "have 60".
 */
const shownCount = async (): Promise<number> => {
  const text = (await win.locator('footer').innerText()).replace(/,/g, '');
  const m = text.match(/(\d+) shown/);
  if (!m) throw new Error(`no "N shown" in status bar: ${text}`);
  return Number(m[1]);
};

const visibleIds = async (): Promise<string[]> =>
  (
    await win
      .locator('[data-asset-id]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-asset-id')))
  ).filter((id): id is string => Boolean(id));

test('marketplace facets filter the grid by orbital match status', async () => {
  test.setTimeout(60_000);

  await expect(win.locator('[data-asset-id]').first()).toBeVisible({ timeout: 8000 });

  // The Marketplace group + its two facets render in the sidebar.
  await expect(win.getByText('Marketplace', { exact: true })).toBeVisible();
  const orbitalBtn = sidebar().getByRole('button', { name: /Orbital matched/ });
  const unmatchedBtn = sidebar().getByRole('button', { name: /Unmatched/ });
  await expect(orbitalBtn).toBeVisible();
  await expect(unmatchedBtn).toBeVisible();

  // Orbital matched facet.
  await orbitalBtn.click();
  await win.waitForTimeout(900);
  await expect(orbitalBtn).toHaveAttribute('aria-pressed', 'true');
  const orbitalIds = await visibleIds();
  console.log(`[test] "Orbital matched" → ${orbitalIds.length} visible card(s)`);
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-marketplace-facets.png') });

  // Unmatched facet.
  await unmatchedBtn.click();
  await win.waitForTimeout(900);
  await expect(unmatchedBtn).toHaveAttribute('aria-pressed', 'true');
  // Same axis, so the previous one released rather than accumulating.
  await expect(orbitalBtn).toHaveAttribute('aria-pressed', 'false');
  const unmatchedIds = await visibleIds();
  console.log(`[test] "Unmatched" → ${unmatchedIds.length} visible card(s)`);

  // At least one facet has results, and the two are disjoint — the filter
  // genuinely partitions (a broken filter would yield identical sets).
  expect(orbitalIds.length + unmatchedIds.length).toBeGreaterThan(0);
  const overlap = orbitalIds.filter((id) => unmatchedIds.includes(id));
  expect(overlap, 'orbital-matched and unmatched results must be disjoint').toEqual([]);
});

/**
 * Facets compose. Before this, picking a second one replaced the first, so
 * "unmatched Blender packs" was three separate questions asked in sequence.
 *
 * The load-bearing assertion is again distribution-independent: an intersection
 * cannot be larger than either operand. Counting rendered cards cannot show
 * that — the grid is virtualized, so every result set over ~60 rows "has 60" —
 * so this reads the status bar's count, which is the number the app itself
 * claims. That makes the assertion a check on two things at once: that the
 * facets compose, and that the count beside them describes the same query.
 */
test('facets intersect, and the chip row states what is applied', async () => {
  test.setTimeout(60_000);

  await expect(win.locator('[data-asset-id]').first()).toBeVisible({ timeout: 8000 });

  // Both tests drive one Electron instance, so the previous one's facet is
  // still applied. Reset rather than assume a clean slate.
  await sidebar()
    .getByRole('button', { name: /All assets/ })
    .click();
  await win.waitForTimeout(700);

  const chips = win.getByRole('group', { name: 'Active filters' });
  // Nothing applied, so the row is absent rather than an empty strip.
  await expect(chips).toBeHidden();

  const unmatchedBtn = sidebar().getByRole('button', { name: /Unmatched/ });
  await unmatchedBtn.click();
  await win.waitForTimeout(700);
  const unmatchedOnly = await shownCount();
  await expect(chips).toBeVisible();

  // Second axis: whichever ecosystem the sidebar actually lists first.
  const ecoBtn = win.locator('[aria-labelledby="source-group-ecosystems"] button').first();
  const ecoLabel = (await ecoBtn.textContent())?.trim() ?? '';
  await ecoBtn.click();
  await win.waitForTimeout(700);

  // Both facets are still held, and both are named.
  await expect(unmatchedBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(ecoBtn).toHaveAttribute('aria-pressed', 'true');
  const chipButtons = chips.getByRole('button');
  // Two facet chips + "Clear all", which only appears past one facet.
  await expect(chipButtons).toHaveCount(3);

  const intersection = await shownCount();
  console.log(`[test] Unmatched → ${unmatchedOnly}; ∩ ${ecoLabel} → ${intersection}`);
  expect(intersection, 'an intersection cannot exceed either operand').toBeLessThanOrEqual(
    unmatchedOnly,
  );
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-facet-intersection.png') });

  // Removing a chip removes exactly that facet, leaving the other applied.
  await chips.getByRole('button', { name: /^Remove filter Unmatched$/ }).click();
  await win.waitForTimeout(700);
  await expect(unmatchedBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(ecoBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.getByRole('button')).toHaveCount(1);

  // "All assets" clears everything and takes the row with it.
  await sidebar()
    .getByRole('button', { name: /All assets/ })
    .click();
  await win.waitForTimeout(700);
  await expect(chips).toBeHidden();
  await expect(ecoBtn).toHaveAttribute('aria-pressed', 'false');
});
