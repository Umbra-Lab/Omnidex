import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract / smoke tests for the root `appRouter`.
 *
 * These assert the *wiring* between the React renderer and the main process:
 *   - every domain sub-router is mounted under its expected key and exposes the
 *     procedures the renderer calls,
 *   - each procedure's zod `.input()` actually gates bad input (rejects) and
 *     accepts good input,
 *   - read/write procedures delegate to the right layer — the DB-backed ones
 *     against a real in-memory SQLite (so a `setTags` truly writes both stores),
 *     the action ones against mocked service functions (so we never hit the
 *     network / `better-sqlite3` / the filesystem watcher),
 *   - the `progress.onProgress` subscription is mounted and relays the shared
 *     `progressBus`.
 *
 * `openDatabase()` is mocked to hand back a `node:sqlite` fixture: the shipping
 * `better-sqlite3` binary is built for Electron's ABI and won't load under the
 * Node that runs Vitest. `node:sqlite` ships the same engine (FTS5 + JSON1) and
 * the same `.prepare().all/get/run` surface the repo layer uses, so the *real*
 * repo code runs against a real database.
 */

// ---------------------------------------------------------------------------
// In-memory DB fixture (real schema for the tables the DB-backed routers touch)
// + the `transaction()` slice `tagsRepo.setAssetTags` relies on.
// ---------------------------------------------------------------------------

const SCHEMA = /* sql */ `
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file_path TEXT,
  asset_type TEXT NOT NULL DEFAULT 'unreal_pack',
  file_size INTEGER NOT NULL DEFAULT 0,
  created_date TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
  modified_date TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
  thumbnail_path TEXT,
  orbital_thumbnail_url TEXT,
  tags TEXT,
  description TEXT,
  scan_location_id INTEGER NOT NULL DEFAULT 1,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  orbital_title TEXT,
  orbital_description TEXT,
  orbital_seller_name TEXT,
  orbital_price REAL,
  orbital_rating_average REAL,
  orbital_rating_count INTEGER,
  orbital_categories TEXT,
  orbital_source_url TEXT,
  orbital_supported_versions TEXT,
  matched_orbital_product_slug TEXT,
  content_format TEXT,
  completion_status TEXT,
  tutorial_source TEXT,
  fab_owned INTEGER NOT NULL DEFAULT 0,
  ecosystem TEXT,
  asset_ecosystem TEXT,
  missing_since TEXT
);

CREATE TABLE asset_marketplace_matches (
  asset_id INTEGER NOT NULL,
  marketplace TEXT NOT NULL
);

-- Mirrors migration 20260805000000. The orbital.match procedure clears an
-- asset's rejections on accept, so the table must exist for it to run.
CREATE TABLE orbital_match_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  product_slug TEXT,
  rejected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_orbital_match_rejections_unique
  ON orbital_match_rejections(asset_id, COALESCE(product_slug, ''));

-- Mirrors the app_settings table in the initial migration.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  setting_type TEXT NOT NULL,
  description TEXT,
  created_date TEXT,
  modified_date TEXT
);

CREATE TABLE asset_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  tag_type TEXT CHECK(tag_type IN ('genre', 'mechanics', 'art_style', 'technical', 'use_case')) NOT NULL,
  confidence REAL CHECK(confidence >= 0.0 AND confidence <= 1.0),
  source TEXT CHECK(source IN ('ai', 'official', 'user')) NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_asset_tags_unique ON asset_tags(asset_id, tag, source);

CREATE TABLE scan_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_scan TEXT,
  scan_recursive INTEGER NOT NULL DEFAULT 1,
  file_extensions TEXT,
  created_date TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
  description TEXT,
  content_format TEXT
);

CREATE VIRTUAL TABLE assets_fts USING fts5(
    name, description, tags, orbital_title, orbital_description, orbital_seller_name,
    content='assets', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER assets_fts_ai AFTER INSERT ON assets BEGIN
    INSERT INTO assets_fts (rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name)
    VALUES (new.id, COALESCE(new.name, ''), COALESCE(new.description, ''), COALESCE(new.tags, ''),
            COALESCE(new.orbital_title, ''), COALESCE(new.orbital_description, ''), COALESCE(new.orbital_seller_name, ''));
END;

CREATE TRIGGER assets_fts_au AFTER UPDATE ON assets BEGIN
    INSERT INTO assets_fts (assets_fts, rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name)
    VALUES ('delete', old.id, COALESCE(old.name, ''), COALESCE(old.description, ''), COALESCE(old.tags, ''),
            COALESCE(old.orbital_title, ''), COALESCE(old.orbital_description, ''), COALESCE(old.orbital_seller_name, ''));
    INSERT INTO assets_fts (rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name)
    VALUES (new.id, COALESCE(new.name, ''), COALESCE(new.description, ''), COALESCE(new.tags, ''),
            COALESCE(new.orbital_title, ''), COALESCE(new.orbital_description, ''), COALESCE(new.orbital_seller_name, ''));
END;
`;

function createTestDb(): Database {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  // `node:sqlite` lacks better-sqlite3's `transaction()` helper that
  // `tagsRepo.setAssetTags` uses. Polyfill the exact slice it relies on.
  (db as unknown as { transaction: (fn: () => void) => () => void }).transaction = (
    fn: () => void,
  ) => {
    return () => {
      db.exec('BEGIN');
      try {
        fn();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    };
  };
  return db as unknown as Database;
}

// The DB the mocked `openDatabase()` hands back. Re-created per test.
let db: Database;

function seedAsset(name: string): number {
  const info = db.prepare('INSERT INTO assets (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Mocks: the DB connection + every action service the routers delegate to.
// The repos themselves stay REAL (they take an explicit `db` arg), so only the
// connection singleton needs faking to run them against the fixture.
// ---------------------------------------------------------------------------

vi.mock('../../db', () => ({
  openDatabase: () => db,
}));

const scannerSvc = {
  refreshAllScans: vi.fn(async () => ({ totalNew: 0, totalUpdated: 0, locations: [] })),
  refreshOneScan: vi.fn((id: number) => ({ locationId: id, started: true })),
  cancelScan: vi.fn((id: number) => ({ locationId: id, cancelled: true })),
};
vi.mock('../../scanner/refresh-all', () => ({
  refreshAllScans: (...a: unknown[]) => scannerSvc.refreshAllScans(...(a as [])),
  refreshOneScan: (...a: unknown[]) => scannerSvc.refreshOneScan(...(a as [number])),
  cancelScan: (...a: unknown[]) => scannerSvc.cancelScan(...(a as [number])),
}));

const activeScanCount = vi.fn(() => 3);
vi.mock('../../scanner/pipeline', () => ({
  activeScanCount: () => activeScanCount(),
}));

const orbitalSvc = {
  enrichOrbital: vi.fn(async () => ({ processed: 0, matched: 0, unmatched: 0 })),
  enrichOneOrbital: vi.fn(async (assetId: number, slug?: string) => ({ assetId, slug, ok: true })),
};
vi.mock('../../orbital/enrich', () => ({
  enrichOrbital: (...a: unknown[]) => orbitalSvc.enrichOrbital(...(a as [])),
  enrichOneOrbital: (...a: unknown[]) =>
    orbitalSvc.enrichOneOrbital(...(a as [number, string | undefined])),
}));

const matchAssetName = vi.fn(async (folderName: string, limit?: number) => [
  { folderName, limit, slug: 'fake-product' },
]);
vi.mock('../../orbital/matcher', () => ({
  matchAssetName: (...a: unknown[]) => matchAssetName(...(a as [string, number | undefined])),
}));

const searchProducts = vi.fn(async (req: { searchText: string; limit?: number }) => [
  { slug: 'hit', title: req.searchText },
]);
vi.mock('../../orbital/search', () => ({
  searchProducts: (...a: unknown[]) =>
    searchProducts(...(a as [{ searchText: string; limit?: number }])),
}));

const enrichFab = vi.fn(async () => ({ processed: 0, updated: 0 }));
vi.mock('../../fab/enrich', () => ({
  enrichFab: (...a: unknown[]) => enrichFab(...(a as [])),
}));

type WatchState = { watching: boolean; root: string | null };
const fabWatcher = {
  start: vi.fn((root?: string): WatchState => ({ watching: true, root: root ?? '/default/vault' })),
  stop: vi.fn(async () => undefined),
  isWatching: vi.fn((): WatchState => ({ watching: false, root: null })),
  defaultVaultPath: vi.fn(() => '/Users/test/FabLibrary'),
};
vi.mock('../../fab/watcher', () => ({
  start: (...a: unknown[]) => fabWatcher.start(...(a as [string | undefined])),
  stop: (...a: unknown[]) => fabWatcher.stop(...(a as [])),
  isWatching: () => fabWatcher.isWatching(),
  defaultVaultPath: () => fabWatcher.defaultVaultPath(),
}));

import type { ActionProgress } from '../../progress/bus';
import { progressBus } from '../../progress/bus';
// Import AFTER the mocks are registered so the router graph binds to them.
import { appRouter } from '../router';

type Caller = ReturnType<typeof appRouter.createCaller>;
let caller: Caller;

beforeEach(() => {
  db = createTestDb();
  caller = appRouter.createCaller({});
  vi.clearAllMocks();
});

afterEach(() => {
  (db as unknown as { close: () => void }).close();
});

// ---------------------------------------------------------------------------
// 1. Router shape — every sub-router mounted, every expected procedure present.
// ---------------------------------------------------------------------------

describe('appRouter shape', () => {
  // tRPC flattens the procedure map to dot-delimited keys on `_def.procedures`.
  const procedures = () =>
    Object.keys(
      (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures,
    );

  it('mounts every domain sub-router under its expected key', () => {
    const keys = procedures();
    const namespaces = new Set(keys.map((k) => k.split('.')[0]));
    expect([...namespaces].sort()).toEqual(
      [
        'ask',
        'assets',
        'collections',
        'courses',
        'fab',
        'libraryHealth',
        'notes',
        'orbital',
        'progress',
        'scanLocations',
        'scanner',
        'settings',
        'updates',
      ].sort(),
    );
  });

  it('exposes the scanner action procedures', () => {
    const keys = procedures();
    expect(keys).toEqual(
      expect.arrayContaining([
        'scanner.refreshAll',
        'scanner.refreshOne',
        'scanner.cancel',
        'scanner.activeCount',
      ]),
    );
  });

  it('exposes the orbital action + read procedures', () => {
    const keys = procedures();
    expect(keys).toEqual(
      expect.arrayContaining([
        'orbital.enrichAll',
        'orbital.match',
        'orbital.candidates',
        'orbital.search',
      ]),
    );
  });

  it('exposes the fab watch + enrich procedures', () => {
    const keys = procedures();
    expect(keys).toEqual(
      expect.arrayContaining([
        'fab.enrich',
        'fab.startWatch',
        'fab.stopWatch',
        'fab.isWatching',
        'fab.defaultVaultPath',
      ]),
    );
  });

  it('exposes the update procedures, and no subscription', () => {
    // A tRPC subscription would be closed by the first in-app navigation; state
    // is pushed as an IPC event instead (see UPDATE_STATE_CHANNEL).
    const procs = (
      appRouter as unknown as { _def: { procedures: Record<string, { _def: { type: string } }> } }
    )._def.procedures;
    const updates = Object.entries(procs).filter(([k]) => k.startsWith('updates.'));
    expect(updates.map(([k]) => k).sort()).toEqual([
      'updates.check',
      'updates.download',
      'updates.install',
      'updates.openRelease',
      'updates.setAutoCheck',
      'updates.state',
    ]);
    expect(updates.some(([, p]) => p._def.type === 'subscription')).toBe(false);
  });

  it('mounts the progress subscription as a subscription procedure', () => {
    const procs = (
      appRouter as unknown as { _def: { procedures: Record<string, { _def: { type: string } }> } }
    )._def.procedures;
    expect(procs['progress.onProgress']).toBeDefined();
    expect(procs['progress.onProgress']._def.type).toBe('subscription');
  });
});

// ---------------------------------------------------------------------------
// 2. assets.setTags / getTags — input validation + real two-store write.
// ---------------------------------------------------------------------------

describe('assets.setTags', () => {
  it('rejects a non-positive / non-integer assetId', async () => {
    await expect(caller.assets.setTags({ assetId: 0, tags: ['x'] })).rejects.toThrow();
    await expect(caller.assets.setTags({ assetId: -1, tags: ['x'] })).rejects.toThrow();
    await expect(caller.assets.setTags({ assetId: 1.5, tags: ['x'] })).rejects.toThrow();
  });

  it('rejects a non-string-array tags payload', async () => {
    await expect(
      // @ts-expect-error — intentionally bad: tags must be string[]
      caller.assets.setTags({ assetId: 1, tags: [1, 2, 3] }),
    ).rejects.toThrow();
    await expect(
      // @ts-expect-error — intentionally bad: tags is required
      caller.assets.setTags({ assetId: 1 }),
    ).rejects.toThrow();
  });

  it('writes both the asset_tags rows AND the assets.tags JSON mirror', async () => {
    const id = seedAsset('Castle Pack');
    const result = await caller.assets.setTags({ assetId: id, tags: ['medieval', 'stone'] });
    expect(result).toBe(true);

    // Canonical store.
    const rows = db
      .prepare("SELECT tag FROM asset_tags WHERE asset_id = ? AND source = 'user' ORDER BY tag")
      .all(id) as { tag: string }[];
    expect(rows.map((r) => r.tag)).toEqual(['medieval', 'stone']);

    // JSON mirror on assets.tags.
    const row = db.prepare('SELECT tags FROM assets WHERE id = ?').get(id) as { tags: string };
    expect(JSON.parse(row.tags).sort()).toEqual(['medieval', 'stone']);

    // And getTags reads the same set back through the router.
    const readBack = await caller.assets.getTags(id);
    expect([...readBack].sort()).toEqual(['medieval', 'stone']);
  });

  it('replaces (not appends) the user tag set on a second call', async () => {
    const id = seedAsset('Castle Pack');
    await caller.assets.setTags({ assetId: id, tags: ['old'] });
    await caller.assets.setTags({ assetId: id, tags: ['new'] });
    expect([...(await caller.assets.getTags(id))]).toEqual(['new']);
  });
});

// ---------------------------------------------------------------------------
// 3. assets read procedures — input gating + real delegation to the repo.
// ---------------------------------------------------------------------------

describe('assets read procedures', () => {
  it('totalCount delegates to the repo against the live DB', async () => {
    seedAsset('A');
    seedAsset('B');
    expect(await caller.assets.totalCount()).toBe(2);
  });

  it('get rejects a non-positive id and returns the row for a valid one', async () => {
    const id = seedAsset('Found Me');
    await expect(caller.assets.get(0)).rejects.toThrow();
    const asset = await caller.assets.get(id);
    expect(asset?.name).toBe('Found Me');
    expect(await caller.assets.get(999_999)).toBeNull();
  });

  it('search validates input shape and runs the FTS query', async () => {
    seedAsset('Dragon Knight Pack');
    seedAsset('Castle Walls');
    const hits = await caller.assets.search({ query: 'dragon' });
    expect(hits.map((h) => h.name)).toEqual(['Dragon Knight Pack']);
    // `query` is required.
    // @ts-expect-error — intentionally bad: missing query
    await expect(caller.assets.search({})).rejects.toThrow();
  });

  it('count applies the match_status filter end-to-end', async () => {
    db.prepare('INSERT INTO assets (name, matched_orbital_product_slug) VALUES (?, ?)').run(
      'Matched',
      'foo',
    );
    seedAsset('Plain');
    const base = {
      asset_type: null,
      tags: null,
      name_search: null,
      is_favorite: null,
      scan_location_id: null,
      date_range: null,
    };
    expect(await caller.assets.count({ ...base, match_status: 'orbital' })).toBe(1);
    expect(await caller.assets.count({ ...base, match_status: 'unmatched' })).toBe(1);
  });

  it('setFavorite validates the id array + boolean and flips the flag', async () => {
    const a = seedAsset('A');
    const b = seedAsset('B');
    await expect(
      // @ts-expect-error — intentionally bad: favorite must be boolean
      caller.assets.setFavorite({ ids: [a], favorite: 'yes' }),
    ).rejects.toThrow();
    await expect(caller.assets.setFavorite({ ids: [a, -1], favorite: true })).rejects.toThrow();

    const ok = await caller.assets.setFavorite({ ids: [a, b], favorite: true });
    expect(ok).toBe(true);
    expect(await caller.assets.favoriteCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. scanLocations.create / update / get — validation + real partial PATCH.
// ---------------------------------------------------------------------------

describe('scanLocations router', () => {
  const fullLocation = {
    name: 'Vault',
    path: '/lib/vault',
    is_active: true,
    last_scan: null,
    scan_recursive: true,
    file_extensions: '.uasset',
    description: 'primary',
  };

  it('create rejects a payload missing required fields', async () => {
    await expect(
      // @ts-expect-error — intentionally bad: path/is_active/... missing
      caller.scanLocations.create({ name: 'Vault' }),
    ).rejects.toThrow();
  });

  it('create inserts a row and get reads it back with normalized booleans', async () => {
    const id = await caller.scanLocations.create(fullLocation);
    expect(id).toBeGreaterThan(0);
    const loc = await caller.scanLocations.get(id);
    expect(loc?.name).toBe('Vault');
    expect(loc?.path).toBe('/lib/vault');
    // Booleans round-trip as real booleans, not 0/1.
    expect(loc?.is_active).toBe(true);
    expect(loc?.scan_recursive).toBe(true);
  });

  it('update validates the id and writes ONLY the provided fields (partial PATCH)', async () => {
    const id = await caller.scanLocations.create(fullLocation);

    // Bad id is rejected before any write.
    await expect(caller.scanLocations.update({ id: 0, name: 'x' })).rejects.toThrow();

    const ok = await caller.scanLocations.update({ id, name: 'Renamed', is_active: false });
    expect(ok).toBe(true);

    const loc = await caller.scanLocations.get(id);
    expect(loc?.name).toBe('Renamed'); // changed
    expect(loc?.is_active).toBe(false); // changed
    expect(loc?.path).toBe('/lib/vault'); // untouched
    expect(loc?.description).toBe('primary'); // untouched
  });

  it('setActive flips only the active flag', async () => {
    const id = await caller.scanLocations.create(fullLocation);
    await caller.scanLocations.setActive({ id, is_active: false });
    expect((await caller.scanLocations.get(id))?.is_active).toBe(false);
  });

  it('delete removes the row', async () => {
    const id = await caller.scanLocations.create(fullLocation);
    await caller.scanLocations.delete(id);
    expect(await caller.scanLocations.get(id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. scanner router — pure delegation to the (mocked) service layer.
// ---------------------------------------------------------------------------

describe('scanner router delegation', () => {
  it('refreshAll calls refreshAllScans and returns its summary', async () => {
    scannerSvc.refreshAllScans.mockResolvedValueOnce({
      totalNew: 7,
      totalUpdated: 2,
      locations: [],
    });
    const res = await caller.scanner.refreshAll();
    expect(scannerSvc.refreshAllScans).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ totalNew: 7, totalUpdated: 2 });
  });

  it('refreshOne validates the id and forwards it', async () => {
    await expect(caller.scanner.refreshOne(0)).rejects.toThrow();
    await caller.scanner.refreshOne(42);
    expect(scannerSvc.refreshOneScan).toHaveBeenCalledWith(42);
  });

  it('cancel validates the id and forwards it', async () => {
    await expect(caller.scanner.cancel(-1)).rejects.toThrow();
    await caller.scanner.cancel(42);
    expect(scannerSvc.cancelScan).toHaveBeenCalledWith(42);
  });

  it('activeCount delegates to pipeline.activeScanCount', async () => {
    activeScanCount.mockReturnValueOnce(5);
    expect(await caller.scanner.activeCount()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 6. orbital router — delegation + no network (services mocked).
// ---------------------------------------------------------------------------

describe('orbital router delegation', () => {
  it('enrichAll delegates to enrichOrbital', async () => {
    await caller.orbital.enrichAll();
    expect(orbitalSvc.enrichOrbital).toHaveBeenCalledTimes(1);
  });

  it('match validates assetId and forwards optional slug', async () => {
    await expect(caller.orbital.match({ assetId: 0 })).rejects.toThrow();

    await caller.orbital.match({ assetId: 12 });
    expect(orbitalSvc.enrichOneOrbital).toHaveBeenLastCalledWith(12, undefined);

    await caller.orbital.match({ assetId: 12, slug: 'pick-me' });
    expect(orbitalSvc.enrichOneOrbital).toHaveBeenLastCalledWith(12, 'pick-me');
  });

  it('candidates is a read query that forwards folderName + limit to the matcher', async () => {
    await expect(
      // @ts-expect-error — intentionally bad: folderName required
      caller.orbital.candidates({}),
    ).rejects.toThrow();
    const res = await caller.orbital.candidates({ folderName: 'Dragon Pack v1.2', limit: 5 });
    expect(matchAssetName).toHaveBeenCalledWith('Dragon Pack v1.2', 5);
    expect(res).toEqual([{ folderName: 'Dragon Pack v1.2', limit: 5, slug: 'fake-product' }]);
  });

  it('search forwards the query into searchProducts as { searchText, limit }', async () => {
    await caller.orbital.search({ query: 'castle', limit: 10 });
    expect(searchProducts).toHaveBeenCalledWith({ searchText: 'castle', limit: 10 });
    // Rejects an invalid limit (must be a positive int).
    await expect(caller.orbital.search({ query: 'castle', limit: -3 })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. fab router — watcher + enrich delegation (no real watcher / network).
// ---------------------------------------------------------------------------

describe('fab router delegation', () => {
  it('enrich forwards optional token/account overrides to enrichFab', async () => {
    await caller.fab.enrich();
    expect(enrichFab).toHaveBeenLastCalledWith(undefined);

    await caller.fab.enrich({ fabToken: 't', fabAccount: 'a' });
    expect(enrichFab).toHaveBeenLastCalledWith({ fabToken: 't', fabAccount: 'a' });
  });

  it('folds a FabAuthRequiredError into a reauthRequired result (not a throw)', async () => {
    const redirectUrl = 'https://www.epicgames.com/id/api/redirect?clientId=x&responseType=code';
    enrichFab.mockRejectedValueOnce({ name: 'FabAuthRequiredError', redirectUrl });
    const res = await caller.fab.enrich();
    expect(res).toMatchObject({ reauthRequired: true, redirectUrl, updated: 0, unmatched: 0 });
  });

  it('rethrows non-auth enrich failures untouched', async () => {
    enrichFab.mockRejectedValueOnce(new Error('network boom'));
    await expect(caller.fab.enrich()).rejects.toThrow('network boom');
  });

  it('startWatch forwards an optional root path to the watcher', async () => {
    await caller.fab.startWatch();
    expect(fabWatcher.start).toHaveBeenLastCalledWith(undefined);

    await caller.fab.startWatch('/custom/vault');
    expect(fabWatcher.start).toHaveBeenLastCalledWith('/custom/vault');
  });

  it('stopWatch awaits stop() and resolves true', async () => {
    expect(await caller.fab.stopWatch()).toBe(true);
    expect(fabWatcher.stop).toHaveBeenCalledTimes(1);
  });

  it('isWatching + defaultVaultPath are read queries onto the watcher state', async () => {
    fabWatcher.isWatching.mockReturnValueOnce({ watching: true, root: '/v' });
    expect(await caller.fab.isWatching()).toEqual({ watching: true, root: '/v' });
    expect(await caller.fab.defaultVaultPath()).toBe('/Users/test/FabLibrary');
  });
});

// ---------------------------------------------------------------------------
// 8. progress.onProgress — the live subscription is wired to the shared bus.
// ---------------------------------------------------------------------------

describe('progress.onProgress subscription', () => {
  // Calling the legacy-observable subscription through the server-side caller
  // resolves to a tRPC observable. Subscribe, publish to the shared bus, assert
  // the event is relayed, then assert the listener is torn down on unsubscribe
  // (no leak across renders / window navigations).
  const sample: ActionProgress = {
    action: 'enrich-orbital',
    phase: 'progress',
    processed: 3,
    total: 10,
    currentName: 'Dragon Pack',
  };

  it('relays an event published to progressBus to the subscriber', async () => {
    const observable = (await caller.progress.onProgress()) as {
      subscribe(obs: { next(v: ActionProgress): void }): { unsubscribe(): void };
    };
    const received: ActionProgress[] = [];
    const sub = observable.subscribe({ next: (v) => received.push(v) });

    progressBus.emit('progress', sample);
    expect(received).toEqual([sample]);

    sub.unsubscribe();
  });

  it('removes its bus listener on unsubscribe (no leak)', async () => {
    const before = progressBus.listenerCount('progress');
    const observable = (await caller.progress.onProgress()) as {
      subscribe(obs: { next(v: ActionProgress): void }): { unsubscribe(): void };
    };
    const sub = observable.subscribe({ next: () => undefined });
    expect(progressBus.listenerCount('progress')).toBe(before + 1);

    sub.unsubscribe();
    expect(progressBus.listenerCount('progress')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 9. updates — opt-in update checks. The electron stub is an unpackaged app, so
//    nothing here can reach the network; the wiring and persistence are real.
// ---------------------------------------------------------------------------

describe('updates router', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is off by default and unsupported outside an installed build', async () => {
    const state = await caller.updates.state();
    expect(state).toMatchObject({
      supported: false,
      autoCheck: false,
      status: { phase: 'idle' },
    });
    expect(state.unsupportedReason).toMatch(/installed builds/i);
  });

  it('setAutoCheck rejects anything but a boolean', async () => {
    await expect(caller.updates.setAutoCheck({ enabled: 'yes' as never })).rejects.toThrow();
    await expect(caller.updates.setAutoCheck({} as never)).rejects.toThrow();
  });

  it('setAutoCheck persists through the settings store and reads back through state', async () => {
    const on = await caller.updates.setAutoCheck({ enabled: true });
    expect(on.autoCheck).toBe(true);
    expect((await caller.settings.get('updates.auto_check'))?.value).toBe('true');
    expect((await caller.updates.state()).autoCheck).toBe(true);

    const off = await caller.updates.setAutoCheck({ enabled: false });
    expect(off.autoCheck).toBe(false);
    expect((await caller.settings.get('updates.auto_check'))?.value).toBe('false');
  });

  it('a manual check in a development build makes no request and reports no error', async () => {
    const state = await caller.updates.check();
    expect(state.status).toEqual({ phase: 'idle' });
  });

  it('install reports that nothing is ready to install', async () => {
    expect(await caller.updates.install()).toEqual({ ok: false });
  });
});
