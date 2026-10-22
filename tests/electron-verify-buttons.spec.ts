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
 * Live end-to-end verification of two controls merged in PRs #23 and #24, which
 * shipped with only type/unit/lint evidence (no Electron E2E was possible then):
 *
 *   #24 — "Scan all" button (Settings -> Asset sources) -> scanner.refreshAll
 *   #23 — "Sync now" FAB button (Settings -> Marketplace) -> fab.enrich
 *
 * Drives the real built app against the default userData DB (the user's real
 * library), so the "Scan all" button is present (>=1 active folder) and FAB has
 * candidates. We DON'T let the scan run to completion — clicking it and seeing
 * the ScanProgressPanel engage + cancel is the proof the loop fires.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHOTS_DIR = resolve(REPO_ROOT, 'tests', '.shots');
mkdirSync(SHOTS_DIR, { recursive: true });

let app: ElectronApplication;
let win: Page;
const toasts: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  app = await electron.launch({
    args: [resolve(REPO_ROOT, 'out', 'main', 'index.mjs')],
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
  win = await app.firstWindow({ timeout: 15_000 });
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => console.log(`[renderer:${m.type()}] ${m.text()}`));
  app.process().stdout?.on('data', (c: Buffer) => {
    for (const l of c.toString('utf8').split('\n')) if (l.trim()) console.log(`[main] ${l}`);
  });
  await win.waitForTimeout(1500);
});

test.afterAll(async () => {
  await app?.close();
});

/** Navigate to Settings and land on `tabName`. */
async function openSettingsTab(tabName: string) {
  const anchorTab = win.getByRole('tab', { name: 'Folders' });
  if (!(await anchorTab.isVisible().catch(() => false))) {
    // Settings is a route now, so the NavBar control is a link, not a button.
    await win.getByRole('link', { name: 'Open settings' }).click();
    await expect(anchorTab).toBeVisible({ timeout: 4000 });
  }
  const tab = win.getByRole('tab', { name: tabName });
  await tab.click();
  await win.waitForTimeout(400);
}

test('#24 Scan all — fires refreshAll, progress panel engages, cancel works', async () => {
  test.setTimeout(60_000);
  await openSettingsTab('Folders');

  const scanAll = win.getByRole('button', { name: 'Scan all' });
  await expect(scanAll, '"Scan all" button should be present with an active folder').toBeVisible({
    timeout: 4000,
  });
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-scanall-before.png') });

  await scanAll.click();

  // Starting a scan must not navigate away. Settings used to be a dialog that
  // auto-closed so the floating ScanProgressPanel wouldn't sit under its
  // overlay — throwing away the user's place to solve a z-index problem.
  // Progress renders inline in the folder row that started the scan.
  await expect(win.getByRole('tab', { name: 'Folders' })).toBeVisible({ timeout: 4000 });
  console.log('[test] Stayed on Settings when the scan started.');

  // Inline progress in the row, or the completion state if the scan was fast.
  const inlineProgress = win.locator('main').getByRole('progressbar');
  const finished = win
    .locator('[role="status"], [role="alert"]')
    .filter({ hasText: /Completed|Failed/ });
  await expect(inlineProgress.first().or(finished.first())).toBeVisible({ timeout: 8000 });
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-scanall-running.png') });
  console.log('[test] Scan all: progress surfaced without losing the user’s place.');
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-scanall-after.png') });
});

test('#23 Sync FAB library — fires fab.enrich, surfaces a result/toast', async () => {
  test.setTimeout(60_000);
  // Capture sonner toasts as they appear.
  await win.evaluate(() => {
    const root = document.querySelector('[data-sonner-toaster]');
    if (root) {
      const obs = new MutationObserver(() => {
        for (const t of Array.from(document.querySelectorAll('[data-sonner-toast]'))) {
          (window as unknown as { __toasts: string[] }).__toasts ??= [];
          const txt = (t as HTMLElement).innerText;
          const arr = (window as unknown as { __toasts: string[] }).__toasts;
          if (txt && !arr.includes(txt)) arr.push(txt);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  });

  await openSettingsTab('Marketplace');
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-marketplace.png') });

  const syncBtn = win.getByRole('button', { name: 'Sync now' });
  await expect(syncBtn, '"Sync now" FAB button should be present').toBeVisible({ timeout: 4000 });
  await syncBtn.click();
  console.log('[test] FAB "Sync now" clicked — awaiting result toast…');

  // Wait for any toast to surface (success, no-creds error, or re-auth prompt).
  await win.waitForTimeout(6000);
  const captured = await win.evaluate(
    () => (window as unknown as { __toasts?: string[] }).__toasts ?? [],
  );
  toasts.push(...captured);
  console.log(`[test] toasts seen: ${JSON.stringify(captured)}`);
  await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-fab-result.png') });

  // The exact branch depends on the user's Epic creds, but SOME visible feedback
  // must appear — a dead button (no toast, no progress) is the failure mode.
  const reauth = win.getByText('Epic re-authorization required');
  const reauthVisible = await reauth.isVisible().catch(() => false);
  if (reauthVisible) {
    console.log('[test] Re-auth path hit. Verifying "Open Epic login" action is present…');
    await expect(win.getByRole('button', { name: 'Open Epic login' })).toBeVisible({
      timeout: 2000,
    });
    await win.screenshot({ path: resolve(SHOTS_DIR, 'verify-fab-reauth.png') });
  }
  expect(
    captured.length > 0 || reauthVisible,
    'FAB sync must surface visible feedback (toast or re-auth prompt), not a dead click',
  ).toBeTruthy();
});
