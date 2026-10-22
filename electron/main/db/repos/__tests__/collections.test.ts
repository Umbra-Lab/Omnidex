import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAssetsToCollection,
  createCollection,
  deleteCollection,
  listCollectionAssetCards,
  listCollections,
  removeAssetsFromCollection,
} from '../collections';

/**
 * Collection-membership round-trip. The shared `createTestDb` fixture ships a
 * minimal `collections (id, name)` and no `collection_items`, but
 * `listCollectionAssetCards` joins `collection_items` → `assets` and projects
 * the card columns. We build a faithful slice of those two tables (only the
 * columns the card projection touches) so the join + ordering behave as in the
 * app. Schema mirrors the production `collections` / `collection_items` shape
 * from the SQLite migrations.
 */
const SCHEMA = /* sql */ `
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  orbital_title TEXT,
  asset_type TEXT NOT NULL DEFAULT 'unreal_pack',
  file_size INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  thumbnail_path TEXT,
  orbital_thumbnail_url TEXT,
  orbital_rating_average REAL,
  orbital_rating_count INTEGER,
  orbital_price REAL,
  orbital_source_url TEXT,
  orbital_supported_versions TEXT,
  orbital_seller_name TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  created_date TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
  fab_owned INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  orbital_categories TEXT,
  missing_since TEXT,
  asset_ecosystem TEXT,
  ecosystem TEXT,
  scan_location_id INTEGER,
  matched_orbital_product_slug TEXT
);

CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  icon TEXT,
  is_smart INTEGER,
  smart_filter TEXT,
  sort_order INTEGER,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE collection_items (
  collection_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  added_at TEXT,
  sort_order INTEGER,
  PRIMARY KEY (collection_id, asset_id)
);
`;

function makeDb(): Database {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  // `node:sqlite` lacks better-sqlite3's `transaction()` helper that
  // `addAssetsToCollection` uses. Polyfill the slice the repo relies on: a
  // function returning a callable that runs the body inside BEGIN/COMMIT
  // (ROLLBACK on throw), forwarding any args through to the body.
  (
    db as unknown as {
      transaction: <T extends unknown[]>(fn: (...args: T) => void) => (...args: T) => void;
    }
  ).transaction = <T extends unknown[]>(fn: (...args: T) => void) => {
    return (...args: T) => {
      db.exec('BEGIN');
      try {
        fn(...args);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    };
  };
  return db as unknown as Database;
}

function seedAsset(db: Database, name: string): number {
  const info = db.prepare('INSERT INTO assets (name) VALUES (?)').run(name);
  return Number(info.lastInsertRowid);
}

describe('collections repo', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    (db as unknown as DatabaseSync).close();
  });

  it('listCollectionAssetCards returns only the members of the given collection', () => {
    const collId = createCollection(db, {
      name: 'Kit',
      description: null,
      color: null,
      icon: null,
      is_smart: null,
      smart_filter: null,
    });
    const a = seedAsset(db, 'Alpha');
    const b = seedAsset(db, 'Beta');
    const outsider = seedAsset(db, 'Outsider');

    addAssetsToCollection(db, collId, [a, b]);

    const cards = listCollectionAssetCards(db, collId);
    expect(cards).toHaveLength(2);
    const names = cards.map((c) => c.name).sort();
    expect(names).toEqual(['Alpha', 'Beta']);
    expect(cards.some((c) => c.id === outsider)).toBe(false);
  });

  it('projects the card columns and normalizes the favorite boolean', () => {
    const collId = createCollection(db, {
      name: 'Faves',
      description: null,
      color: null,
      icon: null,
      is_smart: null,
      smart_filter: null,
    });
    const id = seedAsset(db, 'Solo');
    db.prepare('UPDATE assets SET is_favorite = 1, orbital_title = ? WHERE id = ?').run(
      'Solo (Marketplace)',
      id,
    );
    addAssetsToCollection(db, collId, [id]);

    const [card] = listCollectionAssetCards(db, collId);
    expect(card).toBeDefined();
    expect(card?.id).toBe(id);
    expect(card?.is_favorite).toBe(true);
    expect(card?.orbital_title).toBe('Solo (Marketplace)');
  });

  it('removeAssetsFromCollection drops only the named members', () => {
    const collId = createCollection(db, {
      name: 'Kit',
      description: null,
      color: null,
      icon: null,
      is_smart: null,
      smart_filter: null,
    });
    const a = seedAsset(db, 'Alpha');
    const b = seedAsset(db, 'Beta');
    addAssetsToCollection(db, collId, [a, b]);

    removeAssetsFromCollection(db, collId, [a]);

    const cards = listCollectionAssetCards(db, collId);
    expect(cards.map((c) => c.id)).toEqual([b]);

    // asset_count reflects the removal too
    const listed = listCollections(db).find((c) => c.id === collId);
    expect(listed?.asset_count).toBe(1);
  });

  it('deleteCollection removes the collection from the list', () => {
    const collId = createCollection(db, {
      name: 'Temp',
      description: null,
      color: null,
      icon: null,
      is_smart: null,
      smart_filter: null,
    });
    const a = seedAsset(db, 'Alpha');
    addAssetsToCollection(db, collId, [a]);

    deleteCollection(db, collId);

    expect(listCollections(db).some((c) => c.id === collId)).toBe(false);
  });
});
