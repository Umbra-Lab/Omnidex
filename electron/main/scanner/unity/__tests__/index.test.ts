import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Database } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedAsset } from '../../../db/repos/__tests__/fixtures/test-db';
import { scanUnityLocation } from '..';
import { GUID, samplePackage, writeSampleProject } from './fixtures';

const MIGRATIONS = [
  'electron/main/db/migrations/20261108000000_dcc_index.up.sql',
  'electron/main/db/migrations/20261120000000_unity_index.up.sql',
];

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omnidex-unity-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unityDb(): Database {
  const db = createTestDb();
  db.exec('ALTER TABLE assets ADD COLUMN has_local_thumbnail INTEGER NOT NULL DEFAULT 0');
  for (const file of MIGRATIONS) db.exec(readFileSync(resolve(file), 'utf8'));
  return db;
}

/** A library folder holding one project and one package, the way a person keeps them. */
function library(): { root: string; project: string; pack: string; thumbs: string } {
  const root = tempDir();
  const project = join(root, 'Games', 'GalaxyDemo');
  writeSampleProject(project);
  mkdirSync(join(root, 'Asset Store-5.x', 'Synty Studios', '3D ModelsVehicles'), {
    recursive: true,
  });
  const pack = join(
    root,
    'Asset Store-5.x',
    'Synty Studios',
    '3D ModelsVehicles',
    'POLYGON Fleet.unitypackage',
  );
  writeFileSync(pack, samplePackage());
  return { root, project, pack, thumbs: join(root, '..', `${root.split(/[\\/]/).pop()}-thumbs`) };
}

function rows(db: Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

describe('Unity location scan', () => {
  it('indexes a project and a package without touching Library, Temp or ignored folders', async () => {
    const db = unityDb();
    const { root, project, pack, thumbs } = library();
    dirs.push(thumbs);
    const result = await scanUnityLocation(db, 7, root, new AbortController().signal, thumbs);
    expect(result).toMatchObject({ total: 2, existing: 0, projects: 1, packages: 1, failures: [] });

    expect(
      rows(db, 'SELECT name, asset_type, ecosystem, scan_location_id FROM assets ORDER BY name'),
    ).toEqual([
      { name: 'GalaxyDemo', asset_type: 'unity_project', ecosystem: 'unity', scan_location_id: 7 },
      {
        name: 'POLYGON Fleet',
        asset_type: 'unity_package',
        ecosystem: 'unity',
        scan_location_id: 7,
      },
    ]);
    expect(rows(db, 'SELECT editor_version, render_pipeline FROM unity_projects')).toEqual([
      { editor_version: '6000.3.0f1', render_pipeline: 'urp' },
    ]);

    const projectId = (
      rows(db, 'SELECT id FROM assets WHERE file_path = ?', project)[0] as { id: number }
    ).id;
    const files = rows(
      db,
      'SELECT rel_path, kind, guid, serialization, variant_of FROM unity_assets WHERE container_id = ? ORDER BY rel_path',
      projectId,
    );
    expect(files.map((f) => f.rel_path)).toEqual([
      'Assets/Data/Baked.asset',
      'Assets/Materials/Hull.mat',
      'Assets/Prefabs/Ship Variant.prefab',
      'Assets/Prefabs/Ship.prefab',
      'Assets/Scenes/Main.unity',
      'Assets/Scripts/ShipController.cs',
      'Assets/Shaders/Hull.shadergraph',
      'Assets/Textures/Hull_Albedo.png',
      'Packages/com.galaxy.tools/Runtime/Tool.cs',
      'Packages/com.galaxy.tools/package.json',
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.rel_path, f]));
    expect(byPath['Assets/Data/Baked.asset'].serialization).toBe('binary');
    expect(byPath['Assets/Prefabs/Ship Variant.prefab']).toMatchObject({
      kind: 'prefab_variant',
      variant_of: GUID.ship,
    });

    const usedBy = rows(
      db,
      'SELECT from_guid FROM unity_refs WHERE container_id = ? AND to_guid = ? ORDER BY from_guid',
      projectId,
      GUID.ship,
    ).map((r) => r.from_guid);
    expect(usedBy).toEqual([GUID.variant, GUID.scene].sort());

    // The package's preview became its thumbnail, under Omnidex's own folder only.
    const thumb = rows(db, 'SELECT thumbnail_path FROM assets WHERE file_path = ?', pack)[0]
      .thumbnail_path as string;
    expect(thumb.startsWith(thumbs)).toBe(true);
    expect(existsSync(thumb)).toBe(true);
    expect(existsSync(join(project, 'Library', 'omnidex'))).toBe(false);
    (db as unknown as { close(): void }).close();
  });

  it('rescans only what changed and forgets what was deleted', async () => {
    const db = unityDb();
    const { root, project, thumbs } = library();
    dirs.push(thumbs);
    const signal = new AbortController().signal;
    await scanUnityLocation(db, 7, root, signal, thumbs);
    const before = rows(db, 'SELECT id, rel_path FROM unity_assets ORDER BY rel_path');

    // Drop the material reference from the prefab, delete the variant.
    const shipPath = join(project, 'Assets', 'Prefabs', 'Ship.prefab');
    writeFileSync(
      shipPath,
      readFileSync(shipPath, 'utf8').replace(
        `guid: ${GUID.hull}`,
        'guid: 00000000000000000000000000000000',
      ),
    );
    const later = new Date(Date.now() + 60_000);
    utimesSync(shipPath, later, later);
    rmSync(join(project, 'Assets', 'Prefabs', 'Ship Variant.prefab'));

    const result = await scanUnityLocation(db, 7, root, signal, thumbs);
    expect(result.existing).toBe(2);
    const after = rows(db, 'SELECT id, rel_path FROM unity_assets ORDER BY rel_path');
    expect(after.map((r) => r.rel_path)).not.toContain('Assets/Prefabs/Ship Variant.prefab');
    // Unchanged files keep their row ids.
    const id = (rows: Array<Record<string, unknown>>, path: string) =>
      rows.find((r) => r.rel_path === path)?.id;
    expect(id(after, 'Assets/Materials/Hull.mat')).toBe(id(before, 'Assets/Materials/Hull.mat'));
    expect(
      rows(
        db,
        'SELECT to_guid FROM unity_refs WHERE from_guid = ? AND to_guid = ?',
        GUID.ship,
        GUID.hull,
      ),
    ).toHaveLength(1); // package still has it
    expect(rows(db, 'SELECT 1 FROM unity_refs WHERE from_guid = ?', GUID.variant)).toEqual([]);
    const projectRefs = rows(
      db,
      `SELECT r.to_guid FROM unity_refs r JOIN assets a ON a.id = r.container_id
        WHERE a.asset_type = 'unity_project' AND r.from_guid = ?`,
      GUID.ship,
    ).map((r) => r.to_guid);
    expect(projectRefs).toEqual([GUID.script]);

    // Removing the project from disk prunes it and, by cascade, its contents.
    rmSync(project, { recursive: true, force: true });
    await scanUnityLocation(db, 7, root, signal, thumbs);
    expect(rows(db, "SELECT name FROM assets WHERE asset_type = 'unity_project'")).toEqual([]);
    expect(rows(db, 'SELECT 1 FROM unity_projects')).toEqual([]);
    expect(
      rows(
        db,
        'SELECT DISTINCT a.asset_type FROM unity_assets u JOIN assets a ON a.id = u.container_id',
      ),
    ).toEqual([{ asset_type: 'unity_package' }]);
    (db as unknown as { close(): void }).close();
  });

  it('reports a project another location owns as a failure and keeps going', async () => {
    const db = unityDb();
    const { root, project, thumbs } = library();
    dirs.push(thumbs);
    seedAsset(db, { name: 'Taken', file_path: project, scan_location_id: 1 });
    const result = await scanUnityLocation(db, 7, root, new AbortController().signal, thumbs);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('another scan location');
    expect(rows(db, 'SELECT scan_location_id FROM assets WHERE file_path = ?', project)).toEqual([
      { scan_location_id: 1 },
    ]);
    expect(rows(db, "SELECT name FROM assets WHERE asset_type = 'unity_package'")).toHaveLength(1);
    (db as unknown as { close(): void }).close();
  });

  it('answers Unity questions through the Oracle MCP server', async () => {
    const db = unityDb();
    db.exec(`CREATE TABLE course_files (id INTEGER, asset_id INTEGER, kind TEXT, rel_path TEXT, abs_path TEXT, duration_seconds REAL, chapter TEXT, order_index INTEGER);
      CREATE TABLE transcript_cues (id INTEGER, file_id INTEGER, text TEXT, start_ms INTEGER);
      CREATE VIRTUAL TABLE transcript_fts USING fts5(text, file_id UNINDEXED);`);
    const { root, thumbs } = library();
    dirs.push(thumbs);
    await scanUnityLocation(db, 7, root, new AbortController().signal, thumbs);
    const dbPath = join(tempDir(), 'oracle.db');
    db.prepare('VACUUM INTO ?').run(dbPath);
    (db as unknown as { close(): void }).close();

    const server = spawn(process.execPath, ['scripts/oracle-mcp/server.mjs'], {
      env: { ...process.env, ORACLE_DB: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: server.stdout });
    const waiting = new Map<number, (text: string) => void>();
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message.result.content[0].text);
    });
    let id = 0;
    const ask = (name: string, args: Record<string, unknown>) =>
      new Promise<string>((done) => {
        id += 1;
        waiting.set(id, done);
        server.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`,
        );
      });
    try {
      const projects = await ask('unity_projects', { packages: true });
      expect(projects).toContain('PROJECT GalaxyDemo — Unity 6000.3.0f1, urp');
      expect(projects).toContain('com.unity.inputsystem@1.14.0');
      expect(projects).toContain('PACKAGE POLYGON Fleet');

      const found = await ask('unity_find_asset', { query: 'ship', kind: 'prefab' });
      expect(found).toContain('[GalaxyDemo] Assets/Prefabs/Ship.prefab');
      expect(found).toContain('[POLYGON Fleet] Assets/PolygonFleet/Prefabs/SM_Ship_01.prefab');
      expect(found).not.toContain('Variant');

      const deps = await ask('unity_dependencies', {
        asset: 'Prefabs/Ship.prefab',
        container: 'Galaxy',
      });
      expect(deps).toContain('Uses 2:');
      expect(deps).toContain('Assets/Materials/Hull.mat (material)');
      expect(deps).toContain('Assets/Scripts/ShipController.cs (script)');
      expect(deps).toContain('Used by 2:');
      expect(deps).toContain('Assets/Scenes/Main.unity (scene)');

      const ambiguous = await ask('unity_dependencies', { asset: 'Hull' });
      expect(ambiguous).toContain('matches');

      const outline = await ask('unity_scene_outline', { asset: 'Main.unity' });
      expect(outline).toContain('3 GameObjects, 1 prefab instances');
      expect(outline).toContain('Main Camera — 1 children; Camera');
      expect(outline).toContain('Player Ship — prefab Assets/Prefabs/Ship.prefab');

      const variant = await ask('unity_scene_outline', { asset: 'Ship Variant.prefab' });
      expect(variant).toContain('Variant of: Assets/Prefabs/Ship.prefab');
    } finally {
      server.kill();
      await new Promise<void>((done) => server.once('exit', () => done()));
    }
  });
});
