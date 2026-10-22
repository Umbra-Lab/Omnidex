import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';

/**
 * In-memory SQLite fixture for the assets repo tests.
 *
 * The shipping `better-sqlite3` binary is compiled against Electron's ABI and
 * will not load under the Node that runs Vitest. Node 22+'s built-in
 * `node:sqlite` ships the same SQLite engine (FTS5 + bm25 + JSON1 compiled in)
 * and exposes a `prepare().all()/.get()/.run()` surface that is API-compatible
 * with the slice of `better-sqlite3` the repo layer actually uses — so we drive
 * the real query code against a real SQLite without rebuilding native modules.
 *
 * The `assets` columns mirror the production schema for every field the repo
 * functions touch, and the `assets_fts` virtual table + sync triggers are
 * copied verbatim from `migrations/20260423000000_add_fts5_search.up.sql`, so
 * BM25 ranking behaves exactly as it does in the app.
 */

const SCHEMA = /* sql */ `
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- UNIQUE mirrors production, which declares file_path TEXT NOT NULL UNIQUE.
  -- Without it the scanner's ON CONFLICT(file_path) upsert cannot even be
  -- prepared here, so the fixture could not exercise the real statement.
  -- Nullable so tests that do not care about paths can omit it; SQLite allows
  -- many NULLs in a UNIQUE column.
  file_path TEXT UNIQUE,
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
  file_size_is_partial INTEGER NOT NULL DEFAULT 0,
  missing_since TEXT,
  display_title TEXT
);

CREATE TABLE asset_marketplace_matches (
  asset_id INTEGER NOT NULL,
  marketplace TEXT NOT NULL
);

CREATE TABLE asset_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  rating INTEGER,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE scan_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT);
CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
CREATE TABLE asset_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER, tag TEXT);

-- Mirrors the real cascade so prune behaviour can be tested honestly: the
-- whole point of the soft-delete is that this row must survive a rename.
-- Mirrors migration 20260805000000. The COALESCE unique index matters: SQLite
-- treats NULLs as distinct, so the plain UNIQUE form would let the same asset
-- be dismissed repeatedly and the ON CONFLICT DO NOTHING would never fire.
CREATE TABLE orbital_match_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  product_slug TEXT,
  rejected_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_orbital_match_rejections_unique
  ON orbital_match_rejections(asset_id, COALESCE(product_slug, ''));

CREATE TABLE collection_items (
  collection_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (collection_id, asset_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
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

CREATE TRIGGER assets_fts_ad AFTER DELETE ON assets BEGIN
    INSERT INTO assets_fts (assets_fts, rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name)
    VALUES ('delete', old.id, COALESCE(old.name, ''), COALESCE(old.description, ''), COALESCE(old.tags, ''),
            COALESCE(old.orbital_title, ''), COALESCE(old.orbital_description, ''), COALESCE(old.orbital_seller_name, ''));
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

/** Columns we let a test seed; everything else falls back to a schema default. */
export interface SeedAsset {
  name: string;
  asset_type?: string;
  file_size?: number;
  file_path?: string;
  created_date?: string;
  modified_date?: string;
  thumbnail_path?: string;
  orbital_thumbnail_url?: string;
  tags?: string;
  description?: string;
  scan_location_id?: number;
  is_favorite?: boolean;
  orbital_title?: string;
  orbital_description?: string;
  orbital_seller_name?: string;
  orbital_price?: number;
  orbital_rating_average?: number;
  orbital_rating_count?: number;
  orbital_categories?: string;
  orbital_source_url?: string;
  matched_orbital_product_slug?: string;
  orbital_supported_versions?: string;
  content_format?: string;
  completion_status?: string;
  tutorial_source?: string;
  fab_owned?: boolean;
  ecosystem?: string;
  asset_ecosystem?: string;
  file_size_is_partial?: number;
  missing_since?: string;
  display_title?: string;
}

/**
 * Open a fresh in-memory database with the schema applied. The return value is
 * cast to the `better-sqlite3` `Database` type so it can be handed directly to
 * the repo functions, which only use the `.prepare(...).all/get/run` surface
 * that both engines share.
 */
export function createTestDb(): Database {
  const db = new DatabaseSync(':memory:');
  // Production sets this in `db/connection.ts`. Without it here the ON DELETE
  // CASCADE rules are inert, and a test asserting that curation survives a
  // prune would pass for the wrong reason — there would be no cascade to
  // survive. Mirror the real engine or the guarantee is untested.
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db as unknown as Database;
}

/** Coerce JS values into the primitives node:sqlite accepts when binding. */
function bindable(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as string | number;
}

/**
 * Insert one asset row, returning its new id. Unspecified columns use the
 * schema defaults, so a test can seed `{ name: 'Foo' }` and only override what
 * the assertion cares about.
 */
export function seedAsset(db: Database, asset: SeedAsset): number {
  const cols = Object.keys(asset);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map((c) => bindable((asset as unknown as Record<string, unknown>)[c]));
  const sql = `INSERT INTO assets (${cols.join(', ')}) VALUES (${placeholders})`;
  const info = db.prepare(sql).run(...(values as (string | number | null)[]));
  return Number(info.lastInsertRowid);
}

/** Seed many assets in declaration order; returns the generated ids. */
export function seedAssets(db: Database, assets: SeedAsset[]): number[] {
  return assets.map((a) => seedAsset(db, a));
}

/** Link an asset to a marketplace for the marketplace/unmatched category tests. */
export function linkMarketplace(db: Database, assetId: number, marketplace: string): void {
  db.prepare('INSERT INTO asset_marketplace_matches (asset_id, marketplace) VALUES (?, ?)').run(
    assetId,
    marketplace,
  );
}
