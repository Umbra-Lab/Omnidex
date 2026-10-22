import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedAsset } from '../../db/repos/__tests__/fixtures/test-db';
import { pruneAssetsNotIn } from '../../db/repos/assets';
// From `asset-upsert`, not `pipeline`: pipeline statically imports the napi
// uasset addon, so pulling a SQL string through it made this suite fail on any
// platform without a built `.node` — green on Windows, red on Linux CI.
import { ASSET_UPSERT_SQL } from '../asset-upsert';

/**
 * The scan/prune round trip, against the pipeline's real upsert statement.
 *
 * A pack that is moved or renamed looks exactly like a deleted one to the
 * reconciliation prune — its old path simply stops appearing in the walk. When
 * the prune hard-deleted, `ON DELETE CASCADE` took the user's collection
 * membership, tags and notes with it, and the pack returned on the next scan as
 * a brand-new id with none of it attached. The live library reached 3,010 rows
 * on a sqlite_sequence of 16,098 with all three curation tables at zero.
 *
 * These tests bind to `ASSET_UPSERT_SQL` rather than a copy so the guarantee
 * cannot drift away from the statement the scanner actually runs.
 */

let db: Database;

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  (db as unknown as { close: () => void }).close();
});

/** Run the pipeline's upsert for one folder, the way `startScan` does. */
function scanUpsert(path: string, name: string, locationId = 1): void {
  const now = new Date().toISOString();
  db.prepare(ASSET_UPSERT_SQL).run(
    name,
    path,
    'unreal_pack',
    100,
    0,
    now,
    now,
    locationId,
    'unreal_engine',
    'unreal_engine',
    null,
  );
}

function curate(assetId: number): void {
  db.prepare("INSERT INTO collections (id, name) VALUES (1, 'hall of fame')").run();
  db.prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (1, ?)').run(assetId);
  db.prepare("INSERT INTO asset_tags (asset_id, tag) VALUES (?, 'favourite-kit')").run(assetId);
  db.prepare('INSERT INTO asset_notes (asset_id, rating) VALUES (?, 5)').run(assetId);
}

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

describe('scan prune preserves curation', () => {
  it('a pack that disappears and comes back keeps its collection, tags and notes', () => {
    scanUpsert('/lib/Pack', 'Pack');
    const id = (
      db.prepare('SELECT id FROM assets WHERE file_path = ?').get('/lib/Pack') as { id: number }
    ).id;
    curate(id);

    // Scan 2: the folder is gone (moved away). Prune reconciles.
    pruneAssetsNotIn(db, 1, ['/lib/Something-Else']);
    expect(count('collection_items')).toBe(1);
    expect(count('asset_tags')).toBe(1);
    expect(count('asset_notes')).toBe(1);

    // Scan 3: it is back at the same path.
    scanUpsert('/lib/Pack', 'Pack');

    const row = db
      .prepare('SELECT id, missing_since FROM assets WHERE file_path = ?')
      .get('/lib/Pack') as { id: number; missing_since: string | null };
    // Same id — that is the whole point; a new id would orphan everything.
    expect(row.id).toBe(id);
    expect(row.missing_since).toBeNull();
    expect(count('collection_items')).toBe(1);
    expect(count('asset_tags')).toBe(1);
    expect(count('asset_notes')).toBe(1);
  });

  it('re-scanning an unchanged library is a no-op for ids and curation', () => {
    scanUpsert('/lib/A', 'A');
    scanUpsert('/lib/B', 'B');
    const idA = (
      db.prepare('SELECT id FROM assets WHERE file_path = ?').get('/lib/A') as { id: number }
    ).id;
    curate(idA);

    for (let i = 0; i < 3; i += 1) {
      scanUpsert('/lib/A', 'A');
      scanUpsert('/lib/B', 'B');
      expect(pruneAssetsNotIn(db, 1, ['/lib/A', '/lib/B'])).toBe(0);
    }

    expect(
      (db.prepare('SELECT id FROM assets WHERE file_path = ?').get('/lib/A') as { id: number }).id,
    ).toBe(idA);
    expect(count('assets')).toBe(2);
    expect(count('collection_items')).toBe(1);
  });

  it('an uncurated pack that vanishes is still hard-deleted', () => {
    scanUpsert('/lib/Keep', 'Keep');
    scanUpsert('/lib/Junk', 'Junk');

    expect(pruneAssetsNotIn(db, 1, ['/lib/Keep'])).toBe(1);
    expect(count('assets')).toBe(1);
  });

  it('cascade is live in the fixture, so the guarantee is real', () => {
    // If foreign_keys were OFF this whole suite would pass for the wrong
    // reason — there would be no cascade to protect against.
    const id = seedAsset(db, { name: 'Doomed', scan_location_id: 1, file_path: '/lib/x' });
    db.prepare("INSERT INTO collections (id, name) VALUES (9, 'c')").run();
    db.prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (9, ?)').run(id);
    db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    expect(count('collection_items')).toBe(0);
  });
});
