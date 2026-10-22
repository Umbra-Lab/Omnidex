import { spawnSync } from 'node:child_process';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHOTS_DIR = resolve(REPO_ROOT, 'tests', '.shots');
mkdirSync(SHOTS_DIR, { recursive: true });

/**
 * Inspector-panel UX regression suite. Validates:
 *   - clicking an asset card opens the inspector
 *   - inspector content fits within the panel (no horizontal overflow)
 *   - ArrowRight / ArrowLeft step through gallery images
 *   - Escape closes the inspector
 *   - switching assets resets the gallery to image 1
 *
 * Runs serially against the user's real database so we exercise actual
 * asset shapes (descriptions, gallery image counts, missing thumbnails).
 */

let app: ElectronApplication;
let win: Page;

/**
 * The row `--inject-gallery-fixture` stamped, taken from the fixture process's
 * own stdout. The gallery test used to re-discover it through
 * `window.omnidex.db.assets`, a preload bridge deleted with the Tauri-era IPC —
 * so it threw before reaching its own `test.skip` guard and hard-failed instead
 * of skipping. The fixture already prints the id and name; nothing needed
 * looking up.
 */
let fixtureId: number | null = null;
let fixtureName: string | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // Inject the gallery test fixture before any test launches so the
  // multi-image gallery test has data. Idempotent — re-running just
  // refreshes the same row. The CLI flag is registered in
  // electron/main/index.ts as `--inject-gallery-fixture`. We launch a
  // separate Electron process via the project's `electron` binary so
  // it loads the same package.json (matching app.setName('omnidex') and
  // therefore the same userData) as the test's own launch.
  const electronEntry = resolve(REPO_ROOT, 'node_modules', 'electron', 'cli.js');
  const r = spawnSync(process.execPath, [electronEntry, '.', '--inject-gallery-fixture'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  if (r.status !== 0 || !out.includes('[fixture]')) {
    console.warn(
      `[fixture-setup] exit=${r.status} signal=${r.signal} — gallery test may skip\n` +
        out.split('\n').slice(-8).join('\n'),
    );
  } else {
    console.log(
      '[fixture-setup]',
      out
        .split('\n')
        .filter((l) => l.includes('[fixture]'))
        .join('; '),
    );
  }

  // electron/main/index.ts prints `[fixture] injected gallery into id=<n>
  // name="<name>" (<k> updated)`. Reading it here is the whole lookup.
  const m = out.match(/\[fixture\] injected gallery into id=(\d+) name="([^"]*)"/);
  if (m) {
    fixtureId = Number(m[1]);
    fixtureName = m[2];
  }
});

test.beforeAll(async () => {
  app = await electron.launch({
    args: [resolve(REPO_ROOT, 'out', 'main', 'index.mjs')],
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
  win = await app.firstWindow({ timeout: 15_000 });
  await win.waitForLoadState('domcontentloaded');
  // Resize to a "tight" viewport to exercise the inspector's overflow rules
  // — this is the regime where bugs surface.
  await win.setViewportSize({ width: 1500, height: 900 });
  await win.waitForTimeout(1000);
  // Wait for the asset grid to populate.
  await win.locator('[data-testid="asset-card"]').first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
});

test.afterAll(async () => {
  await app?.close();
});

test('clicking an asset card opens the inspector', async () => {
  await expect(win.locator('[data-testid="inspector"]')).toBeHidden();
  await win.locator('[data-testid="asset-card"]').first().click();
  await expect(win.locator('[data-testid="inspector"]')).toBeVisible({
    timeout: 3000,
  });
});

test('inspector content fits within panel width (no horizontal overflow)', async () => {
  const overflow = await win.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="inspector"]');
    if (!panel) throw new Error('inspector not found');
    // Walk every descendant; flag any whose bounding rect right edge is
    // past the panel's right edge.
    const panelRight = panel.getBoundingClientRect().right;
    const overflowers: { tag: string; text: string; right: number }[] = [];
    for (const el of panel.querySelectorAll<HTMLElement>('*')) {
      const r = el.getBoundingClientRect();
      // Allow 1px tolerance for sub-pixel rounding.
      if (r.right > panelRight + 1) {
        overflowers.push({
          tag: el.tagName,
          text: (el.textContent ?? '').slice(0, 40),
          right: Math.round(r.right - panelRight),
        });
      }
    }
    return { panelRight: Math.round(panelRight), overflowers };
  });
  expect(
    overflow.overflowers,
    `${overflow.overflowers.length} elements overflow panel right edge: ${JSON.stringify(overflow.overflowers.slice(0, 5))}`,
  ).toEqual([]);
});

test('inspector visible content includes title and stat values', async () => {
  // The asset's title must be visible (not just the INSPECTOR header).
  // Using a more specific selector to avoid matching the INSPECTOR header.
  const titleH2 = win.locator('[data-testid="inspector"] h2').first();
  await expect(titleH2).toBeVisible();
  const titleText = (await titleH2.textContent()) ?? '';
  expect(titleText.length).toBeGreaterThan(0);

  // Stat labels and their values must both be visible — the v12 bug had
  // labels showing but values clipped/blank. We assert the rendered text
  // for at least one row contains its label.
  //
  // "Rating" is NOT universal any more. An un-enriched asset used to render
  // "Rating —", which read as "has no rating" when it meant "never looked
  // up"; it now shows one honest line with the verb attached instead. So the
  // assertion forks on which state the panel is in — both are valid, an empty
  // panel is not.
  const inspectorText = (await win.locator('[data-testid="inspector"]').textContent()) ?? '';
  const lower = inspectorText.toLowerCase();
  expect(lower).toContain('added');
  expect(lower).toContain('size on disk');
  if (lower.includes('not matched to a marketplace listing')) {
    expect(lower).toContain('match now');
  } else {
    expect(lower).toContain('rating');
  }
});

test('ArrowRight/ArrowLeft cycle gallery when multi-image present', async () => {
  // The fixture row comes from the beforeAll's stdout. If the user's DB has no
  // asset with a local thumbnail at all, the fixture injects nothing, prints
  // nothing to match, and this test skips.
  test.skip(fixtureId == null, 'fixture not installed — see beforeAll output');
  const targetId = fixtureId;
  const targetName = fixtureName;
  if (targetId == null) return;
  expect(targetName, 'fixture asset has no name').toBeTruthy();

  const search = win.locator('[aria-label="Search assets"]');
  await search.fill(targetName as string);
  await win.waitForTimeout(400);

  const card = win.locator(`[data-testid="asset-card"][data-asset-id="${targetId}"]`);
  await card.waitFor({ state: 'visible', timeout: 5000 });
  await card.click();
  await win.waitForTimeout(300);

  const counter = win.locator('[data-testid="gallery-counter"]');
  await expect(counter).toBeVisible({ timeout: 3000 });
  const before = (await counter.textContent()) ?? '';
  expect(before.trim().startsWith('1 /')).toBe(true);
  await win.keyboard.press('ArrowRight');
  await win.waitForTimeout(200);
  const after = (await counter.textContent()) ?? '';
  expect(after).not.toBe(before);
  expect(after.trim().startsWith('2 /')).toBe(true);

  // Clean up — clear search filter and close inspector so subsequent
  // tests start from a stable state (full grid, no inspector).
  await search.fill('');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
});

test('Escape closes the inspector', async () => {
  // Self-contained: open inspector via first card, then press Escape.
  await win.locator('[data-testid="asset-card"]').first().click();
  await expect(win.locator('[data-testid="inspector"]')).toBeVisible({ timeout: 3000 });
  await win.keyboard.press('Escape');
  await expect(win.locator('[data-testid="inspector"]')).toBeHidden({
    timeout: 3000,
  });
});

test('switching assets resets gallery to image 1', async () => {
  // Open first asset, advance gallery, switch to second asset, verify
  // counter starts at "1 / N" not "2 / N" or whatever was on the previous.
  const cards = win.locator('[data-testid="asset-card"]');
  await cards.first().click();
  await expect(win.locator('[data-testid="inspector"]')).toBeVisible();

  // If counter visible, advance it
  const counter = win.locator('[data-testid="gallery-counter"]');
  if (await counter.isVisible()) {
    await win.keyboard.press('ArrowRight');
    await win.waitForTimeout(150);
    await win.keyboard.press('ArrowRight');
    await win.waitForTimeout(150);
  }

  // Click the SECOND card — that fires onSelect with a different id, the
  // Gallery's useEffect on [asset.id] should reset index to 0.
  await cards.nth(1).click();
  await win.waitForTimeout(300);
  if (await counter.isVisible()) {
    const txt = (await counter.textContent()) ?? '';
    expect(txt.trim().startsWith('1 /')).toBe(true);
  }
});

test('final screenshot for visual review', async () => {
  await win.screenshot({
    path: resolve(SHOTS_DIR, 'inspector-final.png'),
    fullPage: false,
  });
});
