// Generate a synthetic Omnidex DB at an arbitrary asset count, faithful to the
// production schema and FTS5 setup, so the search benchmark can show headroom
// well past the live library size.
//
// Faithful pieces:
//   - `assets` table: the production columns the search query / CARD_COLUMNS read.
//   - `assets_fts`: same fts5(...) virtual table + insert trigger as migration
//     20260423000000_add_fts5_search.up.sql (external-content, porter unicode61).
//   - Null distribution: name always present; orbital_title ~60%, tags ~20%,
//     description ~20% — mirroring the live DB, where most rows carry only a
//     name/orbital_title and tags/description are sparse.
//
// Deterministic: seeded mulberry32 PRNG, so a given (count, seed) always
// produces the identical DB. No Math.random.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Vocabulary overlaps QUERY_SUITE so the benchmark's queries actually match.
const THEMES = [
  'Modular',
  'Stylized',
  'Realistic',
  'Sci-Fi',
  'Fantasy',
  'Medieval',
  'Cyberpunk',
  'Post-Apocalyptic',
  'Low Poly',
  'Procedural',
  'Advanced',
  'Customizable',
  'Hand Painted',
  'Photoreal',
  'Toon',
];
const NOUNS = [
  'Environment',
  'Character',
  'Weapon',
  'Vehicle',
  'Building',
  'City',
  'Foliage',
  'Material',
  'Animation',
  'Blueprint',
  'Dungeon',
  'Landscape',
  'Interior',
  'Spaceship',
  'Creature',
  'Prop',
  'Street',
  'Forest',
  'Castle',
  'Robot',
];
const SUFFIX = [
  'Pack',
  'Kit',
  'Bundle',
  'Collection',
  'Set',
  'System',
  'Toolkit',
  'Starter Pack',
  'Sample',
  'Megapack',
];
const SELLERS = [
  'Quixel',
  'Epic Games',
  'PolyForge',
  'AssetHaven',
  'VertexWorks',
  'NodeCraft',
  'BluePrintLab',
  'MeshMaster',
  'TextureForge',
  'KitBashery',
];
const UE_VERSIONS = ['5.6', '5.5', '5.4', '5.3', '5.2', '5.1', '5.0', '4.27'];

export function generate(outPath, count, seed = 1276) {
  const rnd = mulberry32(seed >>> 0);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;

  const makeName = () => {
    const parts = [pick(THEMES)];
    if (chance(0.5)) parts.push(pick(THEMES));
    parts.push(pick(NOUNS), pick(SUFFIX));
    return parts.join(' ');
  };
  const makeTags = () => {
    const n = 2 + Math.floor(rnd() * 4);
    const t = new Set();
    while (t.size < n) t.add(pick(NOUNS).toLowerCase());
    return JSON.stringify([...t]);
  };
  const makeDescription = () =>
    `${pick(THEMES)} ${pick(NOUNS).toLowerCase()} ${pick(SUFFIX).toLowerCase()} for Unreal Engine ${pick(UE_VERSIONS)}. ` +
    `Includes drag-and-drop ${pick(NOUNS).toLowerCase()} assets, demo level, and ${pick(NOUNS).toLowerCase()} blueprints.`;

  mkdirSync(dirname(outPath), { recursive: true });
  if (existsSync(outPath)) rmSync(outPath, { force: true });
  const db = new Database(outPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE,
      asset_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      created_date TEXT NOT NULL,
      modified_date TEXT NOT NULL,
      thumbnail_path TEXT,
      tags TEXT,
      description TEXT,
      scan_location_id INTEGER NOT NULL,
      is_favorite BOOLEAN NOT NULL DEFAULT 0,
      orbital_title TEXT,
      orbital_description TEXT,
      orbital_seller_name TEXT,
      orbital_price REAL,
      orbital_rating_average REAL,
      orbital_rating_count INTEGER,
      orbital_categories TEXT,
      orbital_thumbnail_url TEXT,
      orbital_source_url TEXT,
      fab_owned BOOLEAN NOT NULL DEFAULT 0
    );
  `);

  // Identical FTS5 setup to the production migration.
  db.exec(`
    CREATE VIRTUAL TABLE assets_fts USING fts5(
      name, description, tags, orbital_title, orbital_description, orbital_seller_name,
      content='assets', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER assets_fts_ai AFTER INSERT ON assets BEGIN
      INSERT INTO assets_fts (rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name)
      VALUES (new.id, COALESCE(new.name,''), COALESCE(new.description,''), COALESCE(new.tags,''),
              COALESCE(new.orbital_title,''), COALESCE(new.orbital_description,''), COALESCE(new.orbital_seller_name,''));
    END;
  `);

  const insert = db.prepare(`
    INSERT INTO assets (
      name, file_path, asset_type, file_size, created_date, modified_date,
      tags, description, scan_location_id, orbital_title, orbital_description,
      orbital_seller_name, orbital_price, orbital_rating_average, orbital_rating_count, fab_owned
    ) VALUES (
      @name, @file_path, 'unreal_engine', @file_size, @ts, @ts,
      @tags, @description, 1, @orbital_title, @orbital_description,
      @orbital_seller_name, @orbital_price, @rating_avg, @rating_count, 0
    )
  `);

  const now = new Date('2026-06-05T00:00:00Z').toISOString();
  const insertMany = db.transaction((n) => {
    for (let i = 0; i < n; i++) {
      const name = makeName();
      const hasOrbital = chance(0.6);
      insert.run({
        name,
        file_path: `E:/synthetic/pack_${i}/${name.replace(/\s+/g, '_')}_${i}.uasset`,
        file_size: 1_000_000 + Math.floor(rnd() * 500_000_000),
        ts: now,
        tags: chance(0.2) ? makeTags() : null,
        description: chance(0.2) ? makeDescription() : null,
        orbital_title: hasOrbital ? `${name} – ${pick(THEMES)} ${pick(NOUNS)}` : null,
        orbital_description: hasOrbital ? makeDescription() : null,
        orbital_seller_name: hasOrbital ? pick(SELLERS) : null,
        orbital_price: hasOrbital ? Math.floor(rnd() * 120) + 4.99 : null,
        rating_avg: hasOrbital ? Math.round((3 + rnd() * 2) * 10) / 10 : null,
        rating_count: hasOrbital ? Math.floor(rnd() * 800) : null,
      });
    }
  });

  const t0 = process.hrtime.bigint();
  insertMany(count);
  db.exec("INSERT INTO assets_fts(assets_fts) VALUES ('optimize');");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const got = db.prepare('SELECT COUNT(*) c FROM assets').get().c;
  const ftsGot = db.prepare('SELECT COUNT(*) c FROM assets_fts').get().c;
  db.close();
  return { outPath, count: got, ftsCount: ftsGot, seed: seed >>> 0, genMs: ms };
}
