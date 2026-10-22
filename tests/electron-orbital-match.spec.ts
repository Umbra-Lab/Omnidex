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
 * Live check of the per-asset Orbital match-correction UI (InspectorPanel
 * "Find/Fix match" → MatchPickerModal → orbital.candidates / orbital.match).
 * Runs against the real userData library; the candidate list is a real Orbital
 * Market call, so it's asserted tolerantly (modal + search must appear; results
 * depend on network).
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

test('per-asset match: inspector button opens the Orbital picker', async () => {
  test.setTimeout(60_000);

  // The default route ("/") is the asset grid — no navigation needed.
  // Open the inspector for the first asset card.
  const card = win.locator('[data-asset-id]').first();
  await expect(card).toBeVisible({ timeout: 8000 });
  await card.click();
  await win.waitForTimeout(600);

  // The marketplace action row exposes "Find match" or "Fix match".
  const matchBtn = win.getByRole('button', { name: /match$/i }).first();
  await expect(matchBtn, 'inspector should expose a Find/Fix match button').toBeVisible({
    timeout: 6000,
  });
  const label = (await matchBtn.textContent())?.trim();
  console.log(`[test] match button label: "${label}"`);
  await matchBtn.click();

  // The MatchPickerModal opens with its title + a search field seeded.
  await expect(win.getByText('Match marketplace listing')).toBeVisible({ timeout: 4000 });
  const search = win.getByPlaceholder('Search Orbital Market…');
  await expect(search).toBeVisible({ timeout: 2000 });
  console.log(`[test] picker open; seeded search = "${await search.inputValue()}"`);

  // Give the real Orbital candidates call a moment, then capture whatever state.
  await win.waitForTimeout(4000);
  const rows = await win.locator('.max-h-\\[360px\\] ul li').count();
  console.log(`[test] candidate rows rendered: ${rows}`);
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-orbital-match.png') });

  // Tolerant: the picker UI must work; result count depends on network/match.
  expect(await search.isVisible()).toBe(true);
});
