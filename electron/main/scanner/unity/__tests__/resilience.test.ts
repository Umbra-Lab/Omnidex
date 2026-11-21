import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Database } from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../db/repos/__tests__/fixtures/test-db';

/**
 * A flaky USB or network drive, simulated: a path listed here fails with that errno.
 * The scan must keep what it indexed there rather than read the failure as a deletion.
 */
const faults = vi.hoisted(() => ({
  readdir: new Map<string, string>(),
  stat: new Map<string, string>(),
  open: new Map<string, string>(),
}));
function fail(code: string, path: unknown): Error {
  return Object.assign(new Error(`${code}: simulated, '${String(path)}'`), { code });
}
vi.mock('node:fs/promises', async () => {
  // The original factory comes back empty for this builtin under jsdom; node:fs's own
  // promises object is the same API.
  const real = (await vi.importActual<typeof import('node:fs')>('node:fs')).promises;
  const wrap =
    <T extends (...args: never[]) => Promise<unknown>>(name: keyof typeof faults, fn: T) =>
    (path: unknown, ...rest: unknown[]) => {
      const code = faults[name].get(String(path));
      return code
        ? Promise.reject(fail(code, path))
        : (fn as never as (...a: unknown[]) => unknown)(path, ...rest);
    };
  const mocked = {
    ...real,
    readdir: wrap('readdir', real.readdir),
    stat: wrap('stat', real.stat),
    open: wrap('open', real.open),
  };
  return { ...mocked, default: mocked };
});

import { scanUnityLocation } from '..';
import { readUnityPackage } from '../unitypackage';
import { GUID, samplePackage, tar, withStoreHeader, writeSampleProject } from './fixtures';

const MIGRATIONS = [
  'electron/main/db/migrations/20261108000000_dcc_index.up.sql',
  'electron/main/db/migrations/20261120000000_unity_index.up.sql',
  'electron/main/db/migrations/20261120010000_unity_asset_store.up.sql',
  'electron/main/db/migrations/20261121000000_unity_known_guids.up.sql',
  'electron/main/db/migrations/20261121010000_unity_asset_folders.up.sql',
];
function unityDb(): Database {
  const db = createTestDb();
  db.exec('ALTER TABLE assets ADD COLUMN has_local_thumbnail INTEGER NOT NULL DEFAULT 0');
  for (const file of MIGRATIONS) db.exec(readFileSync(resolve(file), 'utf8'));
  return db;
}
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omnidex-unity-flaky-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const map of Object.values(faults)) map.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const count = (db: Database, sql: string, ...params: unknown[]) =>
  (db.prepare(sql).get(...params) as { n: number }).n;
const signal = () => new AbortController().signal;

async function scannedProject() {
  const db = unityDb();
  const root = tempDir();
  const project = join(root, 'P');
  writeSampleProject(project);
  await scanUnityLocation(db, 7, root, signal(), tempDir());
  return { db, root, project };
}

describe('Unity scan on a flaky drive', () => {
  it('keeps the rows of a folder or file that failed to read, and reports it', async () => {
    const { db, root, project } = await scannedProject();
    const before = {
      assets: count(db, 'SELECT COUNT(*) AS n FROM unity_assets'),
      refs: count(db, 'SELECT COUNT(*) AS n FROM unity_refs'),
    };
    faults.readdir.set(join(project, 'Assets', 'Prefabs'), 'EIO');
    faults.stat.set(join(project, 'Assets', 'Scenes', 'Main.unity'), 'EBUSY');
    const result = await scanUnityLocation(db, 7, root, signal(), tempDir());
    expect(count(db, 'SELECT COUNT(*) AS n FROM unity_assets')).toBe(before.assets);
    expect(count(db, 'SELECT COUNT(*) AS n FROM unity_refs')).toBe(before.refs);
    expect(result.failures).toEqual([
      `${project}: Assets/Prefabs/: could not be read`,
      `${project}: Assets/Scenes/Main.unity: could not be read`,
    ]);

    // Even the whole Assets/ folder failing to list costs nothing.
    faults.readdir.clear();
    faults.stat.clear();
    faults.readdir.set(join(project, 'Assets'), 'EIO');
    await scanUnityLocation(db, 7, root, signal(), tempDir());
    expect(count(db, 'SELECT COUNT(*) AS n FROM unity_assets')).toBe(before.assets);
  });

  it("keeps a changed file's GUID and references when its .meta or body fails to read", async () => {
    const { db, root, project } = await scannedProject();
    const ship = join(project, 'Assets', 'Prefabs', 'Ship.prefab');
    const scene = join(project, 'Assets', 'Scenes', 'Main.unity');
    const later = new Date(Date.now() + 60_000);
    utimesSync(ship, later, later);
    utimesSync(scene, later, later);
    faults.open.set(`${ship}.meta`, 'EBUSY');
    faults.open.set(scene, 'EIO');
    const result = await scanUnityLocation(db, 7, root, signal(), tempDir());
    expect(
      (
        db
          .prepare("SELECT guid FROM unity_assets WHERE rel_path = 'Assets/Prefabs/Ship.prefab'")
          .get() as {
          guid: string;
        }
      ).guid,
    ).toBe(GUID.ship);
    expect(count(db, 'SELECT COUNT(*) AS n FROM unity_refs WHERE from_guid = ?', GUID.ship)).toBe(
      2,
    );
    expect(count(db, 'SELECT COUNT(*) AS n FROM unity_refs WHERE from_guid = ?', GUID.scene)).toBe(
      1,
    );
    expect(result.failures).toEqual([
      `${project}: Assets/Prefabs/Ship.prefab.meta: could not be read`,
      `${project}: Assets/Scenes/Main.unity: could not be read`,
    ]);
  });

  it("keeps a package's Asset Store identity when its header fails to read once", async () => {
    const db = unityDb();
    const root = tempDir();
    const pack = join(root, 'Pack.unitypackage');
    writeFileSync(pack, withStoreHeader(samplePackage()));
    await scanUnityLocation(db, 7, root, signal(), tempDir());
    faults.open.set(pack, 'EBUSY');
    await scanUnityLocation(db, 7, root, signal(), tempDir());
    expect(db.prepare('SELECT store_id FROM unity_packages').get()).toEqual({ store_id: '102321' });
  });
});

describe('Unity scan keeps what is still on disk', () => {
  const meta = (guid: string) => `fileFormatVersion: 2\nguid: ${guid}\n`;
  const material = (shader: string) =>
    `%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_Shader: {fileID: 4800000, guid: ${shader}, type: 3}\n`;
  function put(base: string, files: Record<string, string | Buffer>): void {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(base, rel, '..'), { recursive: true });
      writeFileSync(join(base, rel), body);
    }
  }
  const packagePaths = (db: Database, base: string) =>
    (
      db.prepare("SELECT file_path FROM assets WHERE asset_type = 'unity_package'").all() as Array<{
        file_path: string;
      }>
    )
      .map((row) => row.file_path.slice(base.length + 1).replaceAll('\\', '/'))
      .sort();

  it('keeps packages beside a loose Assets folder once the folder becomes a project', async () => {
    const db = unityDb();
    const root = tempDir();
    const course = join(root, 'Course');
    put(course, {
      'Assets/A.mat': material('8'.repeat(32)),
      'Assets/A.mat.meta': meta('1'.repeat(32)),
      'c05/Assets/B.mat': material('8'.repeat(32)),
      'c05/Assets/B.mat.meta': meta('2'.repeat(32)),
      'Top.unitypackage': samplePackage(),
      'c05/Beside.unitypackage': samplePackage(),
      'd1/d2/Ok.unitypackage': samplePackage(),
      'd1/d2/d3/Deep.unitypackage': samplePackage(),
    });
    await scanUnityLocation(db, 7, root, signal(), tempDir());
    const expected = [
      'c05/Beside.unitypackage',
      'd1/d2/Ok.unitypackage',
      'd1/d2/d3/Deep.unitypackage',
      'Top.unitypackage',
    ].sort();
    expect(packagePaths(db, course)).toEqual(expected);

    // Opened in Unity: the folder gains project settings and is a full project now.
    put(course, { 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 6000.0.1f1\n' });
    const result = await scanUnityLocation(db, 7, root, signal(), tempDir());
    expect(result.failures).toEqual([]);
    expect(packagePaths(db, course)).toEqual(expected);
  });

  it("re-reads a kept copy whose twin's change cleared the references they share", async () => {
    const db = unityDb();
    const root = tempDir();
    const project = join(root, 'P');
    const shared = '1'.repeat(32);
    put(project, {
      'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.1f1\n',
      'Assets/A.mat': material('8'.repeat(32)),
      'Assets/A.mat.meta': meta(shared),
      'Assets/Copy/A.mat': material('8'.repeat(32)),
      'Assets/Copy/A.mat.meta': meta(shared),
    });
    await scanUnityLocation(db, 7, root, signal(), tempDir());
    rmSync(join(project, 'Assets', 'A.mat'));
    rmSync(join(project, 'Assets', 'A.mat.meta'));
    faults.open.set(join(project, 'Assets', 'Copy', 'A.mat.meta'), 'EBUSY');
    const first = await scanUnityLocation(db, 7, root, signal(), tempDir());
    expect(first.failures).toEqual([`${project}: Assets/Copy/A.mat.meta: could not be read`]);

    faults.open.clear();
    await scanUnityLocation(db, 7, root, signal(), tempDir());
    expect(count(db, 'SELECT COUNT(*) AS n FROM unity_refs WHERE from_guid = ?', shared)).toBe(1);
  });
});

describe('.unitypackage size limits', () => {
  it('ignores a pathname entry too long to be a path, and rejects an oversized long-name header', async () => {
    const dir = tempDir();
    const guid = 'a'.repeat(32);
    const long = join(dir, 'long-pathname.unitypackage');
    writeFileSync(
      long,
      gzipSync(
        tar([
          { name: `${guid}/pathname`, body: `Assets/${'x'.repeat(5000)}.mat` },
          { name: `${guid}/asset`, body: 'x' },
        ]),
      ),
    );
    expect((await readUnityPackage(long)).entries).toEqual([]);

    const header = join(dir, 'long-header.unitypackage');
    writeFileSync(
      header,
      gzipSync(tar([{ name: '././@LongLink', body: 'x'.repeat(70_000), type: 'L' }])),
    );
    await expect(readUnityPackage(header)).rejects.toThrow(/Oversized tar header/);
  });
});
