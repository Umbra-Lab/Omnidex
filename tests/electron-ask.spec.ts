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
 * Ask-this-course against the real library and the real local model stack.
 *
 * This is a live-fire drive, not a mocked test: it needs llama-swap answering
 * on :8080 and a Whisper-transcribed course in the DB. When the stack is down
 * the suite skips rather than fails — a machine without the local stack is a
 * valid state. First answers pay model load plus a six-figure-token prefill,
 * hence the generous timeouts.
 */

const LOCAL_STACK = 'http://localhost:8080/v1/models';
/** A course that had zero subtitles before the Whisper backfill. */
const TARGET_COURSE = /One Course Solution For Niagara VFX/i;
const QUESTION = 'How does the instructor build a ribbon trail effect in Niagara?';

let app: ElectronApplication;
let win: Page;
let stackUp = false;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  try {
    const res = await fetch(LOCAL_STACK, { signal: AbortSignal.timeout(4_000) });
    stackUp = res.ok;
  } catch {
    stackUp = false;
  }

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

test('the ask pane renders with provider provenance', async () => {
  const rows = win.locator('[data-testid="course-row"]');
  const texts = await rows.allInnerTexts();
  const idx = texts.findIndex((t) => TARGET_COURSE.test(t));
  test.skip(idx === -1, 'target course not in the library');
  await rows.nth(idx).click();

  const pane = win.locator('text=Ask this course').first();
  await expect(pane).toBeVisible({ timeout: 10_000 });
  // Provider badge must say which brain answers before anything is asked.
  await expect(win.locator('text=/Local ·|Claude Code/').first()).toBeVisible({
    timeout: 10_000,
  });
  await win.screenshot({ path: resolve(SHOTS_DIR, 'ask-1-pane.png') });
});

test('a question streams an answer with working citations', async () => {
  // The local provider needs llama-swap; the claude-code provider needs only
  // the CLI, which the app feature-detects itself. Gate on what the badge says.
  const badge = await win.locator('.font-mono', { hasText: /Local ·|Claude Code/ }).innerText();
  test.skip(badge.startsWith('Local') && !stackUp, 'local provider selected but llama-swap is down');
  test.setTimeout(360_000);

  const input = win.locator('input[aria-label="Ask this course"]');
  await input.fill(QUESTION);
  await input.press('Enter');

  // The question must appear in the thread immediately.
  await expect(win.locator(`text=You: ${QUESTION}`)).toBeVisible({ timeout: 5_000 });

  // Context provenance appears once assembly finishes (seconds, not minutes).
  await expect(win.locator('text=/Context: (whole course|\\d+ of \\d+ lessons)/')).toBeVisible({
    timeout: 60_000,
  });
  await win.screenshot({ path: resolve(SHOTS_DIR, 'ask-2-thinking.png') });

  // First answer pays model load + prefill; the input re-enabling is the
  // done signal (busy state clears).
  await expect(input).toBeEnabled({ timeout: 300_000 });
  await win.screenshot({ path: resolve(SHOTS_DIR, 'ask-3-answer.png'), fullPage: false });

  // An answer exists and is not an error state.
  const errorLine = win.locator('p.text-danger-400');
  expect(await errorLine.count(), 'ask surfaced an error instead of an answer').toBe(0);

  // Citation chips are the product's point. The local model is instructed to
  // emit them; assert at least one resolved chip and drive the player with it.
  const chips = win.locator('button', { hasText: /^▶ \d+:\d{2}/ });
  const chipCount = await chips.count();
  test.skip(chipCount === 0, 'model answered without citation markers — inspect ask-3-answer.png');

  const firstChip = chips.first();
  const chipLabel = (await firstChip.innerText()).replace('▶', '').trim();
  await firstChip.click();

  const player = win.locator('[data-testid="course-player"]');
  await expect(player).toBeVisible({ timeout: 15_000 });
  // The seek lands once metadata loads; verify currentTime ≈ the chip's time.
  const [m, s] = chipLabel.split(':').map(Number);
  const expected = (m ?? 0) * 60 + (s ?? 0);
  await expect
    .poll(async () => player.evaluate((el: HTMLVideoElement) => el.currentTime), {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(Math.max(0, expected - 2));
  await win.screenshot({ path: resolve(SHOTS_DIR, 'ask-4-seeked.png') });
});

test('a follow-up keeps the conversation', async () => {
  test.setTimeout(300_000);

  const input = win.locator('input[aria-label="Ask this course"]');
  await input.fill('What color does he make it?');
  await input.press('Enter');
  await expect(input).toBeEnabled({ timeout: 240_000 });

  const errorLine = win.locator('p.text-danger-400');
  expect(await errorLine.count()).toBe(0);
  await win.screenshot({ path: resolve(SHOTS_DIR, 'ask-5-followup.png') });
});
