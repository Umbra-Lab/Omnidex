import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getScanLocationRemovalImpact } from '../scan-locations';
import { createTestDb, seedAsset } from './fixtures/test-db';

/**
 * Removing a scan location cascades through `assets` to every note, tag,
 * favourite and collection entry on those assets. The confirm dialog used to
 * say "Indexed assets stay in the library", which was false, so the dialog now
 * shows these counts and they have to be exactly what the cascade will take.
 */
let db: Database;

beforeEach(() => {
  db = createTestDb();
  db.prepare("INSERT INTO scan_locations (id, path) VALUES (1, 'E:/a'), (2, 'E:/b')").run();
  db.prepare("INSERT INTO collections (id, name) VALUES (1, 'Kit'), (2, 'Other')").run();
});
afterEach(() => {
  (db as unknown as { close(): void }).close();
});

describe('getScanLocationRemovalImpact', () => {
  it('counts only what removing this location would delete', () => {
    const a = seedAsset(db, { name: 'A', scan_location_id: 1, is_favorite: true });
    const b = seedAsset(db, { name: 'B', scan_location_id: 1 });
    seedAsset(db, { name: 'C', scan_location_id: 1 });
    const other = seedAsset(db, { name: 'Elsewhere', scan_location_id: 2, is_favorite: true });

    db.prepare("INSERT INTO asset_notes (asset_id, note_text) VALUES (?, 'good pack')").run(a);
    db.prepare('INSERT INTO asset_notes (asset_id, rating) VALUES (?, 4)').run(b);
    // An emptied note row is not something the user would miss.
    db.prepare("INSERT INTO asset_notes (asset_id, note_text) VALUES (?, '  ')").run(b);
    db.prepare("INSERT INTO asset_notes (asset_id, note_text) VALUES (?, 'keep')").run(other);

    db.prepare("INSERT INTO asset_tags (asset_id, tag) VALUES (?, 'rock'), (?, 'moss')").run(a, a);
    db.prepare("INSERT INTO asset_tags (asset_id, tag) VALUES (?, 'rock')").run(b);
    db.prepare("INSERT INTO asset_tags (asset_id, tag) VALUES (?, 'rock')").run(other);

    db.prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (1, ?), (2, ?)').run(
      a,
      a,
    );
    db.prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (1, ?)').run(other);

    expect(getScanLocationRemovalImpact(db, 1)).toEqual({
      assets: 3,
      favorites: 1,
      notes: 2,
      taggedAssets: 2,
      collectionEntries: 2,
    });
  });

  it('reports zeros for a location with nothing indexed', () => {
    expect(getScanLocationRemovalImpact(db, 2)).toEqual({
      assets: 0,
      favorites: 0,
      notes: 0,
      taggedAssets: 0,
      collectionEntries: 0,
    });
  });
});
