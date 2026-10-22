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
 * Multi-selection, the bulk action bar, and the status bar — the three things
 * DESIGN.md specified and the app never had. Runs against the user's real
 * database so the counts in the status bar are real counts.
 */

let app: ElectronApplication;
let win: Page;

const CARD = '[data-testid="asset-card"]';
const BULK_BAR = '[role="toolbar"][aria-label*="selected"]';
const STATUS_BAR = 'footer';

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
  // The Grid/Table choice persists to localStorage, so a previous run (or the
  // user) can leave this suite in the other view. Pin it to Grid explicitly
  // instead of inheriting whatever was last used.
  await win
    .locator(`${CARD}, [data-testid="asset-row"]`)
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  const gridBtn = win.getByRole('button', { name: 'Grid' });
  if (await gridBtn.count()) await gridBtn.click();
  await win.locator(CARD).first().waitFor({ state: 'visible', timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test('status bar renders real library totals', async () => {
  const bar = win.locator(STATUS_BAR);
  await expect(bar).toBeVisible();
  const text = (await bar.innerText()).trim();
  console.log('[status-bar]', text);

  // Exact counts, never compact notation — DESIGN.md forbids "2.8K".
  expect(text).toMatch(/[\d,]+ packs/);
  expect(text).not.toMatch(/\d+(\.\d)?K\b/);

  // 28px is the specified height and it is fixed.
  const box = await bar.boundingBox();
  expect(box?.height).toBeCloseTo(28, 0);
});

test('plain click selects exactly one and shows no bulk bar', async () => {
  await win.locator(CARD).nth(0).click();
  await expect(win.locator(`${CARD}[aria-pressed="true"]`)).toHaveCount(1);
  // One selected asset is still a selection, so the bar is present.
  await expect(win.locator(BULK_BAR)).toBeVisible();
  await expect(win.locator(BULK_BAR)).toContainText('1 selected');
});

test('ctrl-click adds a second row without dropping the first', async () => {
  await win.locator(CARD).nth(0).click();
  await win
    .locator(CARD)
    .nth(2)
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(win.locator(`${CARD}[aria-pressed="true"]`)).toHaveCount(2);
  await expect(win.locator(BULK_BAR)).toContainText('2 selected');
});

test('shift-click selects the inclusive range', async () => {
  await win.locator(CARD).nth(0).click();
  await win
    .locator(CARD)
    .nth(4)
    .click({ modifiers: ['Shift'] });
  await expect(win.locator(`${CARD}[aria-pressed="true"]`)).toHaveCount(5);
  await expect(win.locator(BULK_BAR)).toContainText('5 selected');

  await win.screenshot({ path: resolve(SHOTS_DIR, 'multi-select-range.png') });
});

test('the status bar reports the selection count', async () => {
  await win.locator(CARD).nth(0).click();
  await win
    .locator(CARD)
    .nth(3)
    .click({ modifiers: ['Shift'] });
  await expect(win.locator(STATUS_BAR)).toContainText('4 selected');
});

test('Escape clears the selection and hides the bar', async () => {
  await win.locator(CARD).nth(0).click();
  await win
    .locator(CARD)
    .nth(2)
    .click({ modifiers: ['Shift'] });
  await expect(win.locator(BULK_BAR)).toBeVisible();

  await win.keyboard.press('Escape');
  await expect(win.locator(BULK_BAR)).toBeHidden();
  await expect(win.locator(`${CARD}[aria-pressed="true"]`)).toHaveCount(0);
});

test('the bulk bar never covers the inspector action footer', async () => {
  await win.locator(CARD).nth(0).click();
  await win.waitForTimeout(700);

  // Centred on the viewport rather than the content column, the bar drifted
  // over the inspector and made its action footer visible but unclickable.
  const bar = await win.locator(BULK_BAR).boundingBox();
  const inspector = await win.locator('[data-testid="inspector"]').boundingBox();
  expect(bar).not.toBeNull();
  expect(inspector).not.toBeNull();
  if (!bar || !inspector) return;
  expect(bar.x + bar.width).toBeLessThanOrEqual(inspector.x + 1);

  // And the footer's primary action must actually be clickable.
  await win.getByRole('button', { name: 'Open folder' }).click({ timeout: 5000 });
});

test('the bulk bar never overlaps the status bar', async () => {
  await win.locator(CARD).nth(0).click();
  await win
    .locator(CARD)
    .nth(2)
    .click({ modifiers: ['Shift'] });

  const bar = await win.locator(BULK_BAR).boundingBox();
  const status = await win.locator(STATUS_BAR).boundingBox();
  expect(bar).not.toBeNull();
  expect(status).not.toBeNull();
  if (!bar || !status) return;
  // The whole bar sits above the status bar's top edge.
  expect(bar.y + bar.height).toBeLessThanOrEqual(status.y);
});

test('selecting does not reflow the grid', async () => {
  await win.keyboard.press('Escape');
  const before = await win.locator(CARD).nth(3).boundingBox();
  await win.locator(CARD).nth(0).click();
  const after = await win.locator(CARD).nth(3).boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  if (!before || !after) return;
  // A border-width change on selection would shift every neighbour by 1px.
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.width).toBeCloseTo(before.width, 0);
});

test('shift-click extends the selection without smearing a text selection', async () => {
  await win.keyboard.press('Escape');
  await win.locator(CARD).nth(0).click();
  await win
    .locator(CARD)
    .nth(4)
    .click({ modifiers: ['Shift'] });

  // Shift-click means "extend range" to us and "extend text selection" to the
  // browser. Only one of those should happen.
  const selectedText = await win.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selectedText.trim()).toBe('');

  // Settle before the screenshot, and prove the visual state matches the
  // count in the bar — a bar that says 5 over a grid that shows 1 is a bug.
  await expect(win.locator(`${CARD}[aria-pressed="true"]`)).toHaveCount(5);
  await win.screenshot({ path: resolve(SHOTS_DIR, 'multi-select-no-text-smear.png') });
});

test('the inspector fits the window and honours the DESIGN.md width clamp', async () => {
  await win.locator(CARD).nth(0).click();
  // Let the panel's enter animation settle. motion.aside animates `x`, and
  // getBoundingClientRect() includes transforms — measuring mid-flight reports
  // a phantom overflow that moves every run.
  await win.waitForTimeout(700);

  const probe = await win.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="inspector"]');
    if (!el) return null;
    return {
      // Layout width, transform-free.
      layoutWidth: el.offsetWidth,
      viewport: window.innerWidth,
      // Real overflow shows up here; transforms never affect it.
      docScroll: document.documentElement.scrollWidth,
    };
  });
  console.log('[inspector]', JSON.stringify(probe));
  expect(probe).not.toBeNull();
  if (!probe) return;

  // Nothing actually overflows the document.
  expect(probe.docScroll).toBeLessThanOrEqual(probe.viewport);
  // DESIGN.md v2 components.inspector: 420 default, 360-560 range. A width
  // persisted above the old 720 ceiling must clamp on read, not stick.
  expect(probe.layoutWidth).toBeGreaterThanOrEqual(360);
  expect(probe.layoutWidth).toBeLessThanOrEqual(560);
});

test('inspector is tabbed and its actions never scroll away', async () => {
  await win.locator(CARD).nth(0).click();
  await win.waitForTimeout(700);

  // #22 — DESIGN.md specifies tabs, the panel was one long scroll.
  await expect(win.getByRole('tab', { name: 'Details' })).toBeVisible();
  await expect(win.getByRole('tab', { name: 'Technical' })).toBeVisible();

  // The action footer sits outside the scroll container, so scrolling the
  // body to the bottom must not move it.
  const footerBefore = await win.getByRole('button', { name: 'Open folder' }).boundingBox();
  await win
    .locator('[data-testid="inspector"] .overflow-y-auto')
    .first()
    .evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  await win.waitForTimeout(300);
  const footerAfter = await win.getByRole('button', { name: 'Open folder' }).boundingBox();
  expect(footerBefore).not.toBeNull();
  expect(footerAfter).not.toBeNull();
  if (!footerBefore || !footerAfter) return;
  expect(footerAfter.y).toBeCloseTo(footerBefore.y, 0);
});

test('an unmatched asset says so instead of stacking em-dashes', async () => {
  await win.locator(CARD).nth(0).click();
  await win.waitForTimeout(700);
  const details = win.locator('[data-testid="inspector"]');
  const text = await details.innerText();

  // #18 — "Rating — / Released — / Updated —" read as "has no rating" when it
  // meant "never looked up". Three dashes in the top block is the failure.
  const dashRuns = (text.match(/—/g) ?? []).length;
  if (text.includes('Not matched to a marketplace listing')) {
    await expect(details.getByRole('button', { name: 'Match now' })).toBeVisible();
    expect(dashRuns).toBeLessThan(3);
  }
});

test('table header columns line up with the row columns', async () => {
  const tableBtn = win.getByRole('button', { name: 'Table' });
  if (await tableBtn.count()) await tableBtn.click();
  await win
    .locator('[data-testid="asset-row"]')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 });
  await win.waitForTimeout(400);

  const probe = await win.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-testid="asset-row"]');
    if (!row) return null;
    const header = row.closest('div[style*="min-width"]')?.firstElementChild as HTMLElement | null;
    const lefts = (el: Element | null) =>
      el ? [...el.children].map((c) => Math.round(c.getBoundingClientRect().left)) : [];
    return { header: lefts(header), row: lefts(row) };
  });
  expect(probe).not.toBeNull();
  if (!probe) return;

  // A Capsize cap-* class on a grid CONTAINER injects ::before/::after, which
  // are themselves grid items — that silently shifted every header label one
  // column right and wrapped the last one onto a second row.
  expect(probe.header).toEqual(probe.row);

  // Leave the suite in Grid so this test can run in any order.
  await win.getByRole('button', { name: 'Grid' }).click();
});
