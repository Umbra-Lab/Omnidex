import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FAB library enrichment: fetch failures must be reported (not look like an
 * empty library), mid-pagination auth expiry must surface as auth-required,
 * the listing-type fallback must apply, and id rematch must work through
 * either identifier. `fetch` and the DB are mocked; no network.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db', () => ({ openDatabase: () => h.db }));

import { enrichFab, FabAuthRequiredError } from '../enrich';

const SCHEMA = /* sql */ `
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'unreal_pack',
  content_format TEXT,
  scan_location_id INTEGER NOT NULL DEFAULT 1,
  fab_owned INTEGER NOT NULL DEFAULT 0,
  fab_item_id TEXT,
  orbital_title TEXT,
  orbital_description TEXT,
  orbital_seller_name TEXT,
  orbital_thumbnail_url TEXT,
  orbital_source_url TEXT,
  orbital_supported_versions TEXT,
  orbital_categories TEXT,
  orbital_last_checked_timestamp TEXT,
  tags TEXT
);`;

function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const opts = { fabToken: 't', fabAccount: 'acct-12345678', onProgress: () => {} };
let fetchMock: ReturnType<typeof vi.fn>;

function seed(name: string, fabItemId: string | null = null): void {
  (h.db as Database)
    .prepare('INSERT INTO assets (name, fab_item_id) VALUES (?, ?)')
    .run(name, fabItemId);
}
function row(name: string): { fab_owned: number; asset_type: string; fab_item_id: string | null } {
  return (h.db as Database)
    .prepare('SELECT fab_owned, asset_type, fab_item_id FROM assets WHERE name = ?')
    .get(name) as { fab_owned: number; asset_type: string; fab_item_id: string | null };
}

beforeEach(() => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  h.db = d;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  (h.db as unknown as { close: () => void }).close();
  vi.unstubAllGlobals();
});

describe('enrichFab fetch failures', () => {
  it('reports an HTTP error mid-library and does not enrich from the partial library', async () => {
    seed('Pack One');
    fetchMock
      .mockResolvedValueOnce(
        json(200, { results: [{ title: 'Pack One', assetId: 'a1' }], cursors: { next: 'c2' } }),
      )
      .mockResolvedValueOnce(json(500, { error: 'boom' }));

    const r = await enrichFab(opts);
    expect(r.fetchError).toMatch(/500/);
    expect(r.updated).toBe(0);
    expect(row('Pack One').fab_owned).toBe(0);
  });

  it('reports a network error as a failure rather than an empty library', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const r = await enrichFab(opts);
    expect(r.fetchError).toMatch(/fetch failed/);
    expect(r.libraryItems).toBe(0);
  });

  it('surfaces a 401 mid-pagination as auth-required, not a silent partial result', async () => {
    seed('Pack One');
    fetchMock
      .mockResolvedValueOnce(
        json(200, { results: [{ title: 'Pack One', assetId: 'a1' }], cursors: { next: 'c2' } }),
      )
      .mockResolvedValue(json(401, { error: 'expired' }));

    await expect(enrichFab(opts)).rejects.toBeInstanceOf(FabAuthRequiredError);
    expect(row('Pack One').fab_owned).toBe(0);
  });
});

describe('enrichFab token expiry mid-library', () => {
  const credsPath = `${app.getPath('userData')}/epic_credentials.json`;
  afterEach(() => rmSync(credsPath, { force: true }));

  it('a second expiry after a successful refresh surfaces as auth-required', async () => {
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(
      credsPath,
      JSON.stringify({ access_token: 'old', refresh_token: 'r', account_id: 'acct-12345678' }),
    );
    seed('Pack One');
    let libraryCalls = 0;
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/token')) {
        refreshCalls += 1;
        // First refresh works, the second is rejected.
        return refreshCalls === 1
          ? json(200, { access_token: 'new', refresh_token: 'r2', account_id: 'acct-12345678' })
          : json(400, { error: 'invalid_grant' });
      }
      libraryCalls += 1;
      if (libraryCalls === 1) return json(401, {});
      if (libraryCalls === 2) {
        return json(200, { results: [{ title: 'Pack One' }], cursors: { next: 'c2' } });
      }
      return json(401, {});
    });

    await expect(enrichFab(opts)).rejects.toBeInstanceOf(FabAuthRequiredError);
    expect(row('Pack One').fab_owned).toBe(0);
  });
});

describe('enrichFab matching', () => {
  it('falls back to "Asset" when the listing has no listingType', async () => {
    seed('Pack One');
    fetchMock.mockResolvedValueOnce(json(200, { results: [{ title: 'Pack One', assetId: 'a1' }] }));
    await enrichFab(opts);
    expect(row('Pack One').asset_type).toBe('Asset');
  });

  it('rematches by stored listing id even when the item also has a different assetId', async () => {
    seed('Renamed locally', 'L-1');
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [
          {
            title: 'Remote Title',
            assetId: 'A-1',
            listingType: '3D',
            customAttributes: [{ ListingIdentifier: 'L-1' }],
          },
        ],
      }),
    );
    const r = await enrichFab(opts);
    expect(r.updated).toBe(1);
    expect(row('Renamed locally')).toMatchObject({ fab_owned: 1, asset_type: '3D Asset' });
  });

  it('rematches by assetId too', async () => {
    seed('Renamed locally', 'A-1');
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [
          {
            title: 'Remote Title',
            assetId: 'A-1',
            customAttributes: [{ ListingIdentifier: 'L-1' }],
          },
        ],
      }),
    );
    const r = await enrichFab(opts);
    expect(r.updated).toBe(1);
  });
});
