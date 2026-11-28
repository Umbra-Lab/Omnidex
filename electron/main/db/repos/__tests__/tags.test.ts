import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AssetFilter } from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countAssets, getAssetById, searchAssets } from '../assets';
import { addAssetTags, getAssetTags, officialTagsWriter, searchTags, setAssetTags } from '../tags';

/**
 * `setAssetTags` is the one tag path that crosses three stores at once:
 * the canonical `asset_tags` rows, the `assets.tags` JSON mirror, and — via the
 * `assets_fts_au` trigger — the FTS index. The shared `createTestDb` fixture
 * ships a deliberately minimal `asset_tags (id, asset_id, tag)`; this method
 * relies on the production columns (`source`, `tag_type`, `confidence`) and the
 * `(asset_id, tag, source)` unique index, so we build a faithful schema here
 * instead. The `assets` table + FTS virtual table + triggers are copied from
 * `migrations/20260423000000_add_fts5_search.up.sql` so search behaves exactly
 * as it does in the app.
 */
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

function createDb(): Database {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  // `node:sqlite` lacks better-sqlite3's `transaction()` helper that the repo
  // uses. Polyfill the exact slice the repo relies on: a function that returns
  // a callable which runs the body inside BEGIN/COMMIT (ROLLBACK on throw).
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

function seed(db: Database, name: string, tags: string | null = null): number {
  const info = db
    .prepare('INSERT INTO assets (name, tags) VALUES (?, ?)')
    .run(name, tags as string | null);
  return Number(info.lastInsertRowid);
}

function addTag(db: Database, assetId: number, tag: string, source: string): void {
  db.prepare(
    `INSERT INTO asset_tags (asset_id, tag, tag_type, confidence, source)
     VALUES (?, ?, 'technical', NULL, ?)`,
  ).run(assetId, tag, source);
}

const NO_FILTER: AssetFilter = {
  asset_type: null,
  tags: null,
  name_search: null,
  is_favorite: null,
  scan_location_id: null,
  date_range: null,
  category: null,
  ecosystem: null,
};

let db: Database;

beforeEach(() => {
  db = createDb();
});

afterEach(() => {
  (db as unknown as { close: () => void }).close();
});

describe('setAssetTags', () => {
  it('writes user rows into asset_tags', () => {
    const id = seed(db, 'Castle Pack');
    setAssetTags(db, id, ['medieval', 'stone']);
    expect(
      getAssetTags(db, id)
        .map((t) => t.tag)
        .sort(),
    ).toEqual(['medieval', 'stone']);
  });

  it('re-serializes assets.tags as a plain JSON string array', () => {
    const id = seed(db, 'Castle Pack');
    setAssetTags(db, id, ['medieval', 'stone']);
    const row = db.prepare('SELECT tags FROM assets WHERE id = ?').get(id) as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(['medieval', 'stone']);
  });

  it('makes a new tag visible to FTS search', () => {
    const id = seed(db, 'Castle Pack');
    expect(searchAssets(db, 'medieval')).toHaveLength(0);
    setAssetTags(db, id, ['medieval']);
    expect(searchAssets(db, 'medieval').map((r) => r.id)).toEqual([id]);
  });

  it('makes a new tag visible to the `tags LIKE` filter', () => {
    const id = seed(db, 'Castle Pack');
    setAssetTags(db, id, ['medieval', 'stone']);
    expect(countAssets(db, { ...NO_FILTER, tags: ['medieval'] })).toBe(1);
    expect(countAssets(db, { ...NO_FILTER, tags: ['stone'] })).toBe(1);
    expect(countAssets(db, { ...NO_FILTER, tags: ['missing'] })).toBe(0);
  });

  it('replaces the previous user tags rather than appending', () => {
    const id = seed(db, 'Castle Pack');
    setAssetTags(db, id, ['old']);
    setAssetTags(db, id, ['new']);
    expect(getAssetTags(db, id).map((t) => t.tag)).toEqual(['new']);
    expect(countAssets(db, { ...NO_FILTER, tags: ['old'] })).toBe(0);
    expect(countAssets(db, { ...NO_FILTER, tags: ['new'] })).toBe(1);
  });

  it('keeps the ai/official tags still in the list, with their source, and searchable', () => {
    const id = seed(db, 'Castle Pack');
    addTag(db, id, 'ai-genre', 'ai');
    addTag(db, id, 'official-cat', 'official');
    // The modal shows every tag and saves the whole list.
    setAssetTags(db, id, ['ai-genre', 'official-cat', 'user-tag']);

    const rows = getAssetTags(db, id)
      .map((t) => `${t.tag}:${t.source}`)
      .sort();
    expect(rows).toEqual(['ai-genre:ai', 'official-cat:official', 'user-tag:user']);

    const row = db.prepare('SELECT tags FROM assets WHERE id = ?').get(id) as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(['ai-genre', 'official-cat', 'user-tag']);
    expect(searchAssets(db, 'ai-genre').map((r) => r.id)).toEqual([id]);
  });

  it('removes an ai or official tag the person took out of the list', () => {
    const id = seed(db, 'Castle Pack');
    addTag(db, id, 'ai-genre', 'ai');
    addTag(db, id, 'official-cat', 'official');
    setAssetTags(db, id, ['official-cat']);
    expect(getAssetTags(db, id).map((t) => t.tag)).toEqual(['official-cat']);
    expect(countAssets(db, { ...NO_FILTER, tags: ['ai-genre'] })).toBe(0);
  });

  it('trims, de-dupes, and drops empty tags', () => {
    const id = seed(db, 'Castle Pack');
    setAssetTags(db, id, ['  spaced  ', 'spaced', '', '   ', 'dup', 'dup']);
    expect(
      getAssetTags(db, id)
        .map((t) => t.tag)
        .sort(),
    ).toEqual(['dup', 'spaced']);
  });

  it('nulls assets.tags when cleared to empty (no user or machine tags left)', () => {
    const id = seed(db, 'Castle Pack', '["seed"]');
    setAssetTags(db, id, ['temp']);
    setAssetTags(db, id, []);
    const row = db.prepare('SELECT tags FROM assets WHERE id = ?').get(id) as {
      tags: string | null;
    };
    expect(row.tags).toBeNull();
    expect(getAssetById(db, id)?.tags ?? null).toBeNull();
  });

  it('does not add a user copy of a tag another source already holds', () => {
    const id = seed(db, 'Castle Pack');
    addTag(db, id, 'official-cat', 'official');
    setAssetTags(db, id, ['official-cat']);
    setAssetTags(db, id, ['official-cat']);
    expect(getAssetTags(db, id)).toHaveLength(1);
  });
});

describe('officialTagsWriter — FAB category tags', () => {
  it('does not rewrite (and reindex) the mirror when a re-sync brings the same categories', () => {
    const id = seed(db, 'Castle Pack');
    db.exec(`CREATE TEMP TABLE writes (n INTEGER);
      CREATE TEMP TRIGGER count_writes AFTER UPDATE OF tags ON assets
      BEGIN INSERT INTO writes VALUES (1); END;`);
    const write = officialTagsWriter(db);
    write(id, ['props', 'environments']);
    write(id, ['props', 'environments']);
    write(id, ['environments', 'props']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM writes').get() as { n: number }).n).toBe(1);
    const row = db.prepare('SELECT tags FROM assets WHERE id = ?').get(id) as { tags: string };
    expect(row.tags).toBe('["environments","props"]');
  });

  it('replaces the official tags and leaves user and ai tags, mirror included', () => {
    const id = seed(db, 'Castle Pack');
    setAssetTags(db, id, ['mine']);
    addTag(db, id, 'ai-genre', 'ai');
    addTag(db, id, 'old-cat', 'official');
    officialTagsWriter(db)(id, ['props', 'environments']);

    expect(
      getAssetTags(db, id)
        .map((t) => `${t.tag}:${t.source}`)
        .sort(),
    ).toEqual(['ai-genre:ai', 'environments:official', 'mine:user', 'props:official']);
    const row = db.prepare('SELECT tags FROM assets WHERE id = ?').get(id) as { tags: string };
    expect((JSON.parse(row.tags) as string[]).sort()).toEqual([
      'ai-genre',
      'environments',
      'mine',
      'props',
    ]);
    expect(countAssets(db, { ...NO_FILTER, tags: ['mine'] })).toBe(1);
    expect(countAssets(db, { ...NO_FILTER, tags: ['old-cat'] })).toBe(0);
  });

  it('leaves the official tags alone when the listing has no categories', () => {
    const id = seed(db, 'Castle Pack');
    addTag(db, id, 'old-cat', 'official');
    officialTagsWriter(db)(id, []);
    expect(getAssetTags(db, id).map((t) => t.tag)).toEqual(['old-cat']);
  });

  it('keeps a user tag that matches a category as one tag in the mirror', () => {
    const id = seed(db, 'Castle Pack');
    setAssetTags(db, id, ['props']);
    officialTagsWriter(db)(id, ['props']);
    const row = db.prepare('SELECT tags FROM assets WHERE id = ?').get(id) as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(['props']);
  });
});

describe('migration 20261128000000_unify_asset_tags', () => {
  const sql = readFileSync(
    'electron/main/db/migrations/20261128000000_unify_asset_tags.up.sql',
    'utf8',
  );
  const mirror = (id: number) =>
    (db.prepare('SELECT tags FROM assets WHERE id = ?').get(id) as { tags: string | null }).tags;

  it('puts user tags a FAB sync dropped back in the mirror, and keeps the FAB tags', () => {
    const id = seed(db, 'Synced Pack', '["props","environments"]');
    addTag(db, id, 'mine', 'user');
    db.exec(sql);
    expect(
      getAssetTags(db, id)
        .map((t) => `${t.tag}:${t.source}`)
        .sort(),
    ).toEqual(['environments:user', 'mine:user', 'props:user']);
    expect((JSON.parse(mirror(id) as string) as string[]).sort()).toEqual([
      'environments',
      'mine',
      'props',
    ]);
    expect(countAssets(db, { ...NO_FILTER, tags: ['mine'] })).toBe(1);
    expect(searchAssets(db, 'mine').map((r) => r.id)).toEqual([id]);
  });

  it('stores mirror-only tags as user tags, so a later FAB sync does not delete them', () => {
    const id = seed(db, 'Old Pack', '["hand-typed"]');
    db.exec(sql);
    officialTagsWriter(db)(id, ['props']);
    expect(mirror(id)).toBe('["hand-typed","props"]');
  });

  it('gives mirror-only tags a row, trimmed, skipping blanks and non-strings', () => {
    const id = seed(db, 'Old Pack', '[" stone ", "", 3, null, "stone"]');
    db.exec(sql);
    expect(getAssetTags(db, id).map((t) => t.tag)).toEqual(['stone']);
    expect(mirror(id)).toBe('["stone"]');
  });

  it('survives a mirror that is not a JSON array, and leaves it alone', () => {
    const bad = seed(db, 'Bad', 'not json');
    const obj = seed(db, 'Obj', '{"a":1}');
    addTag(db, bad, 'x', 'user');
    expect(() => db.exec(sql)).not.toThrow();
    expect(mirror(bad)).toBe('not json');
    expect(mirror(obj)).toBe('{"a":1}');
    expect(getAssetTags(db, obj)).toHaveLength(0);
  });

  it('leaves a mirror that already matches as it is, and is safe to run twice', () => {
    const id = seed(db, 'Fine');
    setAssetTags(db, id, ['a', 'b']);
    const before = mirror(id);
    db.exec(sql);
    db.exec(sql);
    expect(mirror(id)).toBe(before);
    expect(getAssetTags(db, id)).toHaveLength(2);
  });
});

describe('addAssetTags — bulk, additive', () => {
  it('adds to every asset without touching what each already had', () => {
    const a = seed(db, 'A');
    const b = seed(db, 'B');
    setAssetTags(db, a, ['keep-me']);
    setAssetTags(db, b, ['also-mine']);

    addAssetTags(db, [a, b], ['wip']);

    // The whole point: a replace would have destroyed both existing tags.
    expect(
      getAssetTags(db, a)
        .map((t) => t.tag)
        .sort(),
    ).toEqual(['keep-me', 'wip']);
    expect(
      getAssetTags(db, b)
        .map((t) => t.tag)
        .sort(),
    ).toEqual(['also-mine', 'wip']);
  });

  it('is idempotent, so a double-click cannot duplicate a tag', () => {
    const a = seed(db, 'A');
    addAssetTags(db, [a], ['wip']);
    addAssetTags(db, [a], ['wip']);
    expect(getAssetTags(db, a).filter((t) => t.tag === 'wip')).toHaveLength(1);
  });

  it('mirrors into assets.tags so FTS and the tag filter see it', () => {
    const a = seed(db, 'A');
    addAssetTags(db, [a], ['niagara']);
    const row = db.prepare('SELECT tags FROM assets WHERE id = ?').get(a) as {
      tags: string | null;
    };
    expect(JSON.parse(row.tags ?? '[]')).toContain('niagara');
  });

  it('trims, de-dupes and drops empty input', () => {
    const a = seed(db, 'A');
    addAssetTags(db, [a], ['  wip  ', 'wip', '', '   ']);
    expect(getAssetTags(db, a).map((t) => t.tag)).toEqual(['wip']);
  });

  it('is a no-op for an empty selection or no usable tags', () => {
    const a = seed(db, 'A');
    expect(addAssetTags(db, [], ['wip'])).toBe(0);
    expect(addAssetTags(db, [a], ['   '])).toBe(0);
    expect(getAssetTags(db, a)).toHaveLength(0);
  });

  it('applies several tags across a large selection', () => {
    const ids = Array.from({ length: 40 }, (_, i) => seed(db, `Pack ${i}`));
    expect(addAssetTags(db, ids, ['wip', 'review'])).toBe(40);
    for (const id of ids) {
      expect(
        getAssetTags(db, id)
          .map((t) => t.tag)
          .sort(),
      ).toEqual(['review', 'wip']);
    }
  });
});

describe('searchTags', () => {
  it('treats _ and % in the query literally', () => {
    const id = seed(db, 'Pack');
    addTag(db, id, 'low_poly', 'user');
    addTag(db, id, 'lowXpoly', 'user');
    addTag(db, id, '100%', 'user');
    expect(searchTags(db, 'low_poly').map((t) => t.tag)).toEqual(['low_poly']);
    expect(searchTags(db, '%').map((t) => t.tag)).toEqual(['100%']);
  });
});
