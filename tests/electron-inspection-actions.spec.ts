import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

test('inspect sparse assets, act on available information, and organize a missing copy', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'omnidex-inspection-test-'));
  const userData = join(root, 'user-data');
  mkdirSync(userData);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OMNIDEX_TEST_USER_DATA;
  // Set the data directory before importing startup, independently of any
  // development-only environment flags in the current checkout.
  const bootstrap = join(root, 'bootstrap.mjs');
  writeFileSync(
    bootstrap,
    `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(userData)});\nawait import(${JSON.stringify(pathToFileURL(resolve('out/main/index.mjs')).href)});\n`,
  );
  const launch = () => electron.launch({ args: [bootstrap], cwd: process.cwd(), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    expect(await app.evaluate(({ app: instance }) => instance.getPath('userData'))).toBe(userData);
    await app.firstWindow();
    await app.close();
    app = undefined;

    const db = new DatabaseSync(join(userData, 'omnidex.db'));
    try {
      db.prepare(
        "INSERT INTO scan_locations (id, name, path, created_date, is_active) VALUES (1, 'Fixture library', ?, datetime('now'), 1)",
      ).run(root);
      const insert = db.prepare(`INSERT INTO assets
        (id, name, file_path, asset_type, file_size, created_date, modified_date,
         scan_location_id, orbital_title, orbital_source_url, fab_owned, missing_since,
         orbital_thumbnail_url, orbital_gallery_images)
        VALUES (?, ?, ?, 'unreal_pack', 1024, datetime('now'), datetime('now'), 1, ?, ?, ?, ?, ?, ?)`);
      insert.run(
        1,
        'Local_Pack_UE5',
        join(root, 'offline', 'pack'),
        null,
        null,
        0,
        null,
        null,
        null,
      );
      insert.run(
        2,
        'FAB_Indexed_Name',
        '',
        'FAB catalogue title',
        'https://www.fab.com/listings/fixture',
        1,
        null,
        null,
        null,
      );
      insert.run(
        3,
        'Missing_Pack',
        join(root, 'offline', 'missing'),
        null,
        null,
        0,
        '2026-10-31',
        null,
        null,
      );
      insert.run(
        4,
        'Gallery_Pack',
        join(root, 'offline', 'gallery'),
        null,
        null,
        0,
        null,
        'https://inspection.test/broken.png',
        JSON.stringify(['https://inspection.test/working.png']),
      );
      db.exec(
        "INSERT INTO collections (id, name) VALUES (1, 'Review assets'); INSERT INTO collection_items (collection_id, asset_id) VALUES (1, 3)",
      );
    } finally {
      db.close();
    }

    app = await launch();
    const win = await app.firstWindow();
    await win.route('https://inspection.test/**', async (route) => {
      if (route.request().url().endsWith('broken.png')) await route.abort();
      else
        await route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
            'base64',
          ),
        });
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1500, 900),
    );
    const panel = win.getByTestId('inspector');
    const search = win.getByRole('textbox', { name: 'Search assets' });
    const inspect = async (id: number, query: string) => {
      await search.fill(query);
      await win.locator(`[data-testid="asset-card"][data-asset-id="${id}"]`).click();
      await expect(panel).toBeVisible();
    };

    await test.step('a sparse local pack explains missing metadata and reports a real shell error', async () => {
      await inspect(1, 'Local_Pack');
      await expect(panel.getByText('No preview available', { exact: true })).toBeVisible();
      await expect(panel.getByText('Not recorded', { exact: true })).toBeVisible();
      await expect(panel.getByRole('tab', { name: 'Description', exact: true })).toBeDisabled();
      await panel.getByRole('button', { name: 'Open folder', exact: true }).click();
      await expect(
        win.getByText('Folder unavailable. Reconnect its drive and rescan.', { exact: true }),
      ).toBeVisible();
      await panel.getByRole('tab', { name: 'Technical', exact: true }).click();
      await expect(panel.getByText(join(root, 'offline', 'pack'), { exact: true })).toBeVisible();
    });

    await test.step('a FAB record keeps its indexed identity and collection action', async () => {
      await inspect(2, 'FAB_Indexed');
      await expect(panel.getByRole('heading', { name: 'FAB catalogue title' })).toBeVisible();
      await expect(panel.getByText('Indexed as FAB_Indexed_Name')).toBeVisible();
      await expect(panel.getByText(/No local path recorded/)).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Open folder', exact: true })).toBeDisabled();
      await expect(panel.getByRole('button', { name: 'View listing', exact: true })).toBeEnabled();
      await expect(win.locator('[data-sonner-toast]')).toHaveCount(0);
      await test.info().attach('catalogue-inspector', {
        body: await win.screenshot(),
        contentType: 'image/png',
      });
      await panel.getByRole('button', { name: 'Add to collection', exact: true }).click();
      const dialog = win.getByRole('dialog');
      await dialog.getByRole('button', { name: /Review assets/ }).click();
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step('gallery failure, arrow navigation, and Escape still work', async () => {
      await inspect(4, 'Gallery_Pack');
      await expect(panel.getByText('Preview unavailable', { exact: true })).toBeVisible();
      await panel.getByRole('button', { name: 'Next image', exact: true }).focus();
      await win.keyboard.press('ArrowRight');
      await expect(panel.getByTestId('gallery-counter')).toHaveText('2 / 2');
      await expect(panel.getByText('Preview unavailable', { exact: true })).toBeHidden();
      await expect
        .poll(() =>
          panel
            .locator('img')
            .first()
            .evaluate((img) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
      await win.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    });

    await test.step('a retained missing pack remains organizable at the minimum window size', async () => {
      await win.evaluate(() => {
        window.location.hash = '#/collections/1';
      });
      await win.locator('[data-testid="asset-card"][data-asset-id="3"]').click();
      await expect(panel.getByText(/Not found in the last scan/)).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Open folder', exact: true })).toBeDisabled();
      await expect(win.locator('[data-testid="asset-card"][data-asset-id="2"]')).toBeVisible();
      await app?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1024, 768),
      );
      const splitter = panel.getByRole('separator', { name: 'Resize inspector panel' });
      await splitter.focus();
      await win.keyboard.press('End');
      await expect(splitter).toHaveAttribute('aria-valuenow', '360');
      const add = panel.getByRole('button', { name: 'Add to collection', exact: true });
      await expect(add).toBeInViewport();
      await expect
        .poll(async () =>
          panel.evaluate((el) => {
            const right = el.getBoundingClientRect().right;
            if (right > window.innerWidth + 1) return false;
            return [...el.querySelectorAll('button')].every(
              (button) => button.getBoundingClientRect().right <= right + 1,
            );
          }),
        )
        .toBe(true);
      await expect(win.locator('[data-sonner-toast]')).toHaveCount(0);
      await test.info().attach('missing-inspector-1024', {
        body: await win.screenshot(),
        contentType: 'image/png',
      });
      await panel.getByRole('button', { name: 'Manage tags', exact: true }).click();
      await expect(
        win.getByRole('dialog').getByRole('heading', { name: 'Manage tags', exact: true }),
      ).toBeVisible();
    });
  } finally {
    await app?.close();
    // Only remove the exact temporary test root, never a computed ancestor.
    if (dirname(realpathSync(root)) === realpathSync(tmpdir())) {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.error('Unexpected test root; leaving the fixture directory intact.');
    }
  }
});
