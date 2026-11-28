import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteAssets, getAssetRemovalImpact } from '../assets';
import { createTestDb, seedAsset } from './fixtures/test-db';

/**
 * Removing assets from the library cascades to every note, tag, favourite,
 * collection entry, lesson progress and match decision on them, and the next
 * scan re-adds the folders as new assets without any of it. The confirm shows
 * these counts, so they must be exactly what the delete takes.
 */
let db: Database;

beforeEach(() => {
  db = createTestDb();
  db.exec(`
    CREATE TABLE course_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, rel_path TEXT NOT NULL,
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE);
    CREATE TABLE course_progress (
      file_id INTEGER PRIMARY KEY, position_seconds REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (file_id) REFERENCES course_files(id) ON DELETE CASCADE);
  `);
  db.prepare("INSERT INTO scan_locations (id, path) VALUES (1, 'E:/a')").run();
  db.prepare("INSERT INTO collections (id, name) VALUES (1, 'Kit'), (2, 'Other')").run();
});
afterEach(() => {
  (db as unknown as { close(): void }).close();
});

describe('deleteAssets', () => {
  it('deletes a selection larger than the SQLite parameter limit', () => {
    const only = seedAsset(db, { name: 'Only', scan_location_id: 1 });
    const kept = seedAsset(db, { name: 'Kept', scan_location_id: 1 });
    const ids = Array.from({ length: 40_000 }, (_, i) => i + 3);
    ids.push(only);
    expect(deleteAssets(db, ids)).toBe(1);
    const left = db.prepare('SELECT id FROM assets').all() as { id: number }[];
    expect(left.map((r) => r.id)).toEqual([kept]);
  });

  it('deletes nothing for an empty selection', () => {
    seedAsset(db, { name: 'Kept', scan_location_id: 1 });
    expect(deleteAssets(db, [])).toBe(0);
  });
});

describe('getAssetRemovalImpact', () => {
  it('counts only what deleting these assets would take', () => {
    const a = seedAsset(db, { name: 'A', scan_location_id: 1, is_favorite: true });
    const b = seedAsset(db, { name: 'B', scan_location_id: 1 });
    const kept = seedAsset(db, { name: 'Kept', scan_location_id: 1, is_favorite: true });

    db.prepare("INSERT INTO asset_notes (asset_id, note_text) VALUES (?, 'good pack')").run(a);
    db.prepare('INSERT INTO asset_notes (asset_id, rating) VALUES (?, 4)').run(b);
    db.prepare("INSERT INTO asset_notes (asset_id, note_text) VALUES (?, '  ')").run(b);
    db.prepare("INSERT INTO asset_notes (asset_id, note_text) VALUES (?, 'keep')").run(kept);
    db.prepare("INSERT INTO asset_tags (asset_id, tag) VALUES (?, 'rock'), (?, 'moss')").run(a, a);
    db.prepare("INSERT INTO asset_tags (asset_id, tag) VALUES (?, 'rock')").run(kept);
    db.prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (1, ?), (2, ?)').run(
      a,
      a,
    );
    db.prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (1, ?)').run(kept);
    db.prepare("INSERT INTO course_files (asset_id, rel_path) VALUES (?, 'a.mp4')").run(b);
    db.prepare("INSERT INTO course_files (asset_id, rel_path) VALUES (?, 'b.mp4')").run(b);
    db.prepare(
      'INSERT INTO course_progress (file_id, position_seconds, completed) VALUES (1, 30, 0), (2, 0, 0)',
    ).run();
    db.prepare("INSERT INTO orbital_match_rejections (asset_id, product_slug) VALUES (?, 'x')").run(
      b,
    );

    const impact = getAssetRemovalImpact(db, [a, b]);
    expect(impact).toEqual({
      assets: 2,
      favorites: 1,
      notes: 2,
      taggedAssets: 1,
      collectionEntries: 2,
      lessonsWithProgress: 1,
      matchDecisions: 1,
      notRescanned: 0,
    });
  });

  it('flags legacy FAB vault rows, which no scan adds back', () => {
    db.prepare("INSERT INTO scan_locations (id, path) VALUES (-1, 'FAB')").run();
    const fab = seedAsset(db, { name: 'Vault', scan_location_id: -1 });
    const scanned = seedAsset(db, { name: 'Disk', scan_location_id: 1 });
    expect(getAssetRemovalImpact(db, [fab, scanned]).notRescanned).toBe(1);
    expect(getAssetRemovalImpact(db, [scanned]).notRescanned).toBe(0);
  });

  it('handles a selection larger than the SQLite parameter limit', () => {
    const ids = Array.from({ length: 40_000 }, (_, i) => i + 1);
    seedAsset(db, { name: 'Only', scan_location_id: 1 });
    expect(getAssetRemovalImpact(db, ids).assets).toBe(1);
  });

  it('reports zeros for an empty selection', () => {
    expect(getAssetRemovalImpact(db, []).assets).toBe(0);
  });
});
