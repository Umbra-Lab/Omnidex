import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../db/repos/__tests__/fixtures/test-db';
import { scanDccLocation } from '../../dcc-index';
import { scanUnityLocation } from '..';
import { samplePackage, writeSampleProject } from './fixtures';

const MIGRATIONS = [
  'electron/main/db/migrations/20261108000000_dcc_index.up.sql',
  'electron/main/db/migrations/20261120000000_unity_index.up.sql',
  'electron/main/db/migrations/20261120010000_unity_asset_store.up.sql',
  'electron/main/db/migrations/20261121000000_unity_known_guids.up.sql',
  'electron/main/db/migrations/20261121010000_unity_asset_folders.up.sql',
];
const DCC = 1;
const UNITY = 7;

function db(): Database {
  const db = createTestDb();
  db.exec('ALTER TABLE assets ADD COLUMN has_local_thumbnail INTEGER NOT NULL DEFAULT 0');
  // The app's tag and note tables, which the shared test schema trims down.
  db.exec(`DROP TABLE asset_tags; DROP TABLE asset_notes;
    CREATE TABLE asset_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL,
      tag TEXT NOT NULL, tag_type TEXT NOT NULL, confidence REAL, source TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE);
    CREATE TABLE asset_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL,
      note_text TEXT, rating REAL, tested_ue_versions TEXT, reminders TEXT, created_at TEXT,
      updated_at TEXT, FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE);`);
  for (const file of MIGRATIONS) db.exec(readFileSync(resolve(file), 'utf8'));
  return db;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omnidex-unity-dcc-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
function rows(db: Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}
const idOf = (db: Database, path: string) =>
  (db.prepare('SELECT id FROM assets WHERE file_path = ?').get(path) as { id: number } | undefined)
    ?.id;

/** A Unity project with a model in Assets/, a Blender source beside it, and a package. */
function library() {
  const root = tempDir();
  const project = join(root, 'GalaxyDemo');
  writeSampleProject(project);
  const model = join(project, 'Assets', 'Models', 'Hero_Body.fbx');
  const source = join(project, 'Source', 'Hero.blend');
  const pack = join(root, 'Fleet.unitypackage');
  mkdirSync(join(model, '..'), { recursive: true });
  mkdirSync(join(source, '..'), { recursive: true });
  writeFileSync(model, 'fbx');
  writeFileSync(`${model}.meta`, `fileFormatVersion: 2\nguid: ${'5'.repeat(32)}\n`);
  writeFileSync(source, 'blend');
  const textures = join(project, 'Assets', 'Rock');
  mkdirSync(textures, { recursive: true });
  for (const map of ['Rock_BaseColor.png', 'Rock_Normal.png']) {
    writeFileSync(join(textures, map), 'png');
    writeFileSync(join(textures, `${map}.meta`), `fileFormatVersion: 2\nguid: ${'6'.repeat(32)}\n`);
  }
  writeFileSync(pack, samplePackage());
  return { root, project, model, source, pack, textures };
}

describe('a DCC and a Unity location over the same Unity project', () => {
  it('folds the DCC rows into the Unity entry, keeping what the person added', async () => {
    const database = db();
    const { root, project, model, source, pack, textures } = library();
    await scanDccLocation(database, DCC, root, signal());
    expect(idOf(database, textures)).toBeDefined();
    const modelId = idOf(database, model);
    const packId = idOf(database, pack);
    expect(modelId).toBeDefined();
    expect(packId).toBeDefined();

    // What the person did with the DCC row for the model.
    database.exec("INSERT INTO collections (id, name) VALUES (1, 'Heroes')");
    database
      .prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (1, ?)')
      .run(modelId);
    database
      .prepare(
        "INSERT INTO asset_tags (asset_id, tag, tag_type, source) VALUES (?, 'hero', 'technical', 'user')",
      )
      .run(modelId);
    database
      .prepare(
        "INSERT INTO asset_notes (asset_id, note_text, rating) VALUES (?, 'rig is clean', 4)",
      )
      .run(modelId);
    database.prepare('UPDATE assets SET is_favorite = 1 WHERE id = ?').run(modelId);
    database
      .prepare(
        "INSERT INTO asset_tags (asset_id, tag, tag_type, source) VALUES (?, 'fleet', 'technical', 'user')",
      )
      .run(packId);

    const result = await scanUnityLocation(database, UNITY, root, signal(), tempDir());
    expect(result.failures).toEqual([]);

    const projectId = idOf(database, project);
    // The model's DCC row is gone; what was on it is on the project now.
    expect(idOf(database, model)).toBeUndefined();
    expect(
      rows(database, 'SELECT collection_id FROM collection_items WHERE asset_id = ?', projectId),
    ).toEqual([{ collection_id: 1 }]);
    expect(rows(database, 'SELECT tag FROM asset_tags WHERE asset_id = ?', projectId)).toEqual([
      { tag: 'hero' },
    ]);
    expect(rows(database, 'SELECT tags, is_favorite FROM assets WHERE id = ?', projectId)).toEqual([
      { tags: '["hero"]', is_favorite: 1 },
    ]);
    expect(
      rows(database, 'SELECT note_text, rating FROM asset_notes WHERE asset_id = ?', projectId),
    ).toEqual([
      {
        note_text: `${join('Assets', 'Models', 'Hero_Body.fbx')} (rated 4/5): rig is clean`,
        rating: 4,
      },
    ]);
    // The model stays findable from the library search, through the project.
    const search = String(
      rows(database, 'SELECT scan_search_text FROM assets WHERE id = ?', projectId)[0]
        .scan_search_text,
    );
    expect(search).toContain('Hero Body fbx');
    expect(search).toContain('mesh general 3d');
    expect(idOf(database, textures)).toBeUndefined();
    expect(search).toContain('texture set');
    expect(search).toContain('Rock');
    expect(search).toContain('Rock Base Color png');

    // The package row is taken over in place: same id, so its tag stays.
    expect(
      rows(
        database,
        'SELECT id, asset_type, scan_location_id FROM assets WHERE file_path = ?',
        pack,
      ),
    ).toEqual([{ id: packId, asset_type: 'unity_package', scan_location_id: UNITY }]);
    expect(rows(database, 'SELECT tag FROM asset_tags WHERE asset_id = ?', packId)).toEqual([
      { tag: 'fleet' },
    ]);

    // The Blender source beside Assets/ is not in the Unity index, so it stays a DCC file.
    expect(
      rows(database, 'SELECT asset_type, scan_location_id FROM assets WHERE file_path = ?', source),
    ).toEqual([{ asset_type: 'dcc_scene', scan_location_id: DCC }]);

    // The DCC location rescans cleanly and does not bring the duplicates back.
    const again = await scanDccLocation(database, DCC, root, signal());
    expect(idOf(database, model)).toBeUndefined();
    expect(rows(database, 'SELECT asset_type FROM assets WHERE file_path = ?', pack)).toEqual([
      { asset_type: 'unity_package' },
    ]);
    expect(idOf(database, source)).toBeDefined();
    expect(again.total).toBe(
      rows(database, 'SELECT id FROM assets WHERE scan_location_id = ?', DCC).length,
    );
  });

  it('leaves Unity content alone when the DCC location scans second', async () => {
    const database = db();
    const { root, model, source, pack } = library();
    await scanUnityLocation(database, UNITY, root, signal(), tempDir());
    // Before, the shared .unitypackage made this scan throw and index nothing.
    await scanDccLocation(database, DCC, root, signal());
    expect(idOf(database, model)).toBeUndefined();
    expect(rows(database, 'SELECT scan_location_id FROM assets WHERE file_path = ?', pack)).toEqual(
      [{ scan_location_id: UNITY }],
    );
    expect(rows(database, 'SELECT asset_type FROM assets WHERE file_path = ?', source)).toEqual([
      { asset_type: 'dcc_scene' },
    ]);
  });

  it('keeps the DCC rows of a Unity project no Unity location covers', async () => {
    const database = db();
    const { root, model } = library();
    await scanDccLocation(database, DCC, root, signal());
    expect(rows(database, 'SELECT asset_type FROM assets WHERE file_path = ?', model)).toEqual([
      { asset_type: 'dcc_mesh' },
    ]);
  });
  it('skips a file whose Unity entry is stamped missing instead of failing the scan', async () => {
    const database = db();
    const { root, pack, source } = library();
    await scanUnityLocation(database, UNITY, root, signal(), tempDir());
    database
      .prepare("UPDATE assets SET missing_since = '2026-11-01' WHERE file_path = ?")
      .run(pack);
    await scanDccLocation(database, DCC, root, signal());
    expect(rows(database, 'SELECT scan_location_id FROM assets WHERE file_path = ?', pack)).toEqual(
      [{ scan_location_id: UNITY }],
    );
    expect(idOf(database, source)).toBeDefined();
  });
});

// better-sqlite3 binds numbered parameters (?1) as named ones, so a positional .run()
// throws in the app while node:sqlite in these tests accepts it. Keep them out of SQL.
it('uses no numbered SQL parameters in the main process', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(path);
      } else if (entry.name.endsWith('.ts')) {
        readFileSync(path, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (/(?<![?\w)\]'"])\?\d/.test(line)) offenders.push(`${path}:${index + 1}`);
          });
      }
    }
  };
  walk(resolve('electron/main'));
  expect(offenders).toEqual([]);
});
