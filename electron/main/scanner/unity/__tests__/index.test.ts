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
import { boundedLines } from '../project';
import { GUID, PACKAGE_GUID, samplePackage, withStoreHeader, writeSampleProject } from './fixtures';

const MIGRATIONS = [
  'electron/main/db/migrations/20261108000000_dcc_index.up.sql',
  'electron/main/db/migrations/20261120000000_unity_index.up.sql',
  'electron/main/db/migrations/20261120010000_unity_asset_store.up.sql',
  'electron/main/db/migrations/20261121000000_unity_known_guids.up.sql',
  'electron/main/db/migrations/20261121010000_unity_asset_folders.up.sql',
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
  writeFileSync(pack, withStoreHeader(samplePackage()));
  return { root, project, pack, thumbs: join(root, '..', `${root.split(/[\\/]/).pop()}-thumbs`) };
}

function rows(db: Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

describe('Unity location scan', () => {
  it('cuts very long lines instead of buffering them whole', async () => {
    const dir = tempDir();
    const path = join(dir, 'Mesh.asset');
    writeFileSync(path, `%YAML 1.1\r\n  _typelessdata: ${'ab'.repeat(200_000)}\nnext\n`);
    const lines: string[] = [];
    for await (const line of boundedLines(path, 1000)) lines.push(line);
    expect(lines.map((line) => line.length)).toEqual([9, 1000, 4]);
    expect(lines[2]).toBe('next');
  });

  it('indexes ordinary Assets folders named like Unity caches, and copies sharing a GUID', async () => {
    const db = unityDb();
    const root = tempDir();
    writeSampleProject(root);
    mkdirSync(join(root, 'Assets', 'Scripts', 'Build'), { recursive: true });
    writeFileSync(join(root, 'Assets', 'Scripts', 'Build', 'Builder.cs'), 'class Builder {}');
    // A copy made outside Unity keeps the original's .meta, so both files share a GUID.
    const copy = join(root, 'Assets', 'Prefabs', 'Ship Copy.prefab');
    writeFileSync(copy, readFileSync(join(root, 'Assets', 'Prefabs', 'Ship.prefab')));
    writeFileSync(
      `${copy}.meta`,
      readFileSync(join(root, 'Assets', 'Prefabs', 'Ship.prefab.meta')),
    );
    const signal = new AbortController().signal;
    await scanUnityLocation(db, 7, root, signal, join(root, 'thumbs'));
    expect(
      rows(db, 'SELECT 1 FROM unity_assets WHERE rel_path = ?', 'Assets/Scripts/Build/Builder.cs'),
    ).toHaveLength(1);

    rmSync(copy);
    await scanUnityLocation(db, 7, root, signal, join(root, 'thumbs'));
    const refs = rows(
      db,
      'SELECT to_guid FROM unity_refs WHERE from_guid = ? ORDER BY to_guid',
      GUID.ship,
    );
    expect(refs.map((r) => r.to_guid)).toEqual([GUID.hull, GUID.script].sort());
    (db as unknown as { close(): void }).close();
  });

  it('fails the scan when the root cannot be read, and keeps the index when it lists empty', async () => {
    const db = unityDb();
    const signal = new AbortController().signal;
    await expect(
      scanUnityLocation(db, 7, join(tempDir(), 'unplugged'), signal, tempDir()),
    ).rejects.toThrow();

    const { root, project, pack, thumbs } = library();
    dirs.push(thumbs);
    await scanUnityLocation(db, 7, root, signal, thumbs);
    rmSync(project, { recursive: true, force: true });
    rmSync(pack);
    const result = await scanUnityLocation(db, 7, root, signal, thumbs);
    expect(result.total).toBe(0);
    // An empty root may be an unmounted drive or an unsynced folder: nothing is pruned.
    expect(rows(db, 'SELECT 1 FROM assets WHERE scan_location_id = 7')).toHaveLength(2);
    expect(result.failures).toEqual([
      `${root}: no Unity projects or packages found; kept the 2 already indexed`,
    ]);
    (db as unknown as { close(): void }).close();
  });

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
      'Assets/Materials/Water.mat',
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

  it("learns Unity package GUIDs from a project's PackageCache, once per version", async () => {
    const db = unityDb();
    const { root, project, thumbs } = library();
    dirs.push(thumbs);
    const signal = new AbortController().signal;
    await scanUnityLocation(db, 7, root, signal, thumbs);
    const learned = rows(db, 'SELECT * FROM unity_known_guids WHERE version IS NOT NULL');
    expect(learned).toEqual([
      {
        guid: PACKAGE_GUID.urpLit,
        package: 'com.unity.render-pipelines.universal',
        version: '17.3.0',
        rel_path: 'Shaders/Lit.shader',
      },
    ]);
    expect(
      rows(db, 'SELECT 1 FROM unity_known_guids WHERE guid = ?', PACKAGE_GUID.urpTest),
    ).toEqual([]);
    expect(rows(db, 'SELECT package, version FROM unity_package_cache_seen')).toEqual([
      { package: 'com.unity.render-pipelines.universal', version: '17.3.0' },
    ]);
    // The seed shipped with the migration is still there.
    expect(
      rows(
        db,
        'SELECT package, rel_path FROM unity_known_guids WHERE guid = ?',
        PACKAGE_GUID.seededNoise,
      ),
    ).toEqual([
      {
        package: 'com.unity.render-pipelines.universal',
        rel_path: 'Textures/BlueNoise16/L/LDR_LLL1_9.png',
      },
    ]);

    // A version already read is not read again, even when its files change.
    const cached = join(
      project,
      'Library/PackageCache/com.unity.render-pipelines.universal@2c4f1a9e7b3d/Shaders/Unlit.shader.meta',
    );
    writeFileSync(cached, 'fileFormatVersion: 2\nguid: 31313131313131313131313131313131\n');
    await scanUnityLocation(db, 7, root, signal, thumbs);
    expect(
      rows(db, 'SELECT COUNT(*) AS n FROM unity_known_guids WHERE version IS NOT NULL'),
    ).toEqual([{ n: 1 }]);
    (db as unknown as { close(): void }).close();
  });

  it('indexes Assets folders that have no project settings of their own', async () => {
    const db = unityDb();
    const { root, project, thumbs } = library();
    dirs.push(thumbs);
    // A course chapter's materials inside the project, its name garbled by a zip tool
    // (CP949 bytes read as cp437), and an Assets folder copied out on its own.
    const chapter = join(project, 'c04_░╘└╙ └╠╞σ┼═', 'Assets');
    const loose = join(root, 'Loose Effects', 'Assets');
    for (const [dir, guid] of [
      [chapter, '44444444444444444444444444444444'],
      [loose, '55555555555555555555555555555555'],
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'Fx.mat'), '%YAML 1.1\nMaterial:\n  m_Name: Fx\n');
      writeFileSync(join(dir, 'Fx.mat.meta'), `fileFormatVersion: 2\nguid: ${guid}\n`);
    }
    const result = await scanUnityLocation(db, 7, root, new AbortController().signal, thumbs);
    expect(result).toMatchObject({ total: 4, projects: 3, packages: 1, failures: [] });
    expect(
      rows(
        db,
        `SELECT a.name, p.editor_version, p.render_pipeline, p.assets_only, p.settings_from
           FROM assets a JOIN unity_projects p ON p.asset_id = a.id ORDER BY a.name`,
      ),
    ).toEqual([
      {
        name: 'GalaxyDemo',
        editor_version: '6000.3.0f1',
        render_pipeline: 'urp',
        assets_only: 0,
        settings_from: null,
      },
      {
        name: 'Loose Effects',
        editor_version: null,
        render_pipeline: 'unknown',
        assets_only: 1,
        settings_from: null,
      },
      {
        name: 'c04_게임 이펙터',
        editor_version: '6000.3.0f1',
        render_pipeline: 'urp',
        assets_only: 1,
        settings_from: project,
      },
    ]);
    // The chapter's files belong to the chapter, not to the project around it.
    const chapterFiles = rows(
      db,
      `SELECT u.rel_path FROM unity_assets u JOIN assets a ON a.id = u.container_id
         WHERE a.name = 'c04_게임 이펙터'`,
    );
    expect(chapterFiles).toEqual([{ rel_path: 'Assets/Fx.mat' }]);
    expect(rows(db, "SELECT 1 FROM unity_assets WHERE rel_path LIKE 'c04%'")).toEqual([]);
    (db as unknown as { close(): void }).close();
  });

  it('keeps walking past a loose Assets folder, and keeps what sits beside it', async () => {
    const db = unityDb();
    const { root, project, pack, thumbs } = library();
    dirs.push(thumbs);
    const signal = new AbortController().signal;
    await scanUnityLocation(db, 7, root, signal, thumbs);
    // A stray Assets/ appears at the scan root itself, above the project and the package.
    mkdirSync(join(root, 'Assets'));
    writeFileSync(join(root, 'Assets', 'Fx.mat'), '%YAML 1.1\nMaterial:\n  m_Name: Fx\n');
    writeFileSync(
      join(root, 'Assets', 'Fx.mat.meta'),
      `fileFormatVersion: 2\nguid: ${'8'.repeat(32)}\n`,
    );
    // And a full project ships inside the first one, with its own settings.
    const inner = join(project, 'Samples', 'Legacy');
    mkdirSync(join(inner, 'Assets'), { recursive: true });
    mkdirSync(join(inner, 'ProjectSettings'), { recursive: true });
    writeFileSync(
      join(inner, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2019.4.1f1\n',
    );
    writeFileSync(
      join(inner, 'Assets', 'Old.mat.meta'),
      `fileFormatVersion: 2\nguid: ${'9'.repeat(32)}\n`,
    );
    writeFileSync(join(inner, 'Assets', 'Old.mat'), '%YAML 1.1\nMaterial:\n  m_Name: Old\n');

    const result = await scanUnityLocation(db, 7, root, signal, thumbs);
    expect(result).toMatchObject({ projects: 3, packages: 1, failures: [] });
    const containers = rows(
      db,
      `SELECT a.file_path, p.assets_only, p.editor_version FROM assets a
         LEFT JOIN unity_projects p ON p.asset_id = a.id ORDER BY a.file_path`,
    );
    expect(containers).toEqual(
      expect.arrayContaining([
        { file_path: root, assets_only: 1, editor_version: null },
        { file_path: project, assets_only: 0, editor_version: '6000.3.0f1' },
        { file_path: inner, assets_only: 0, editor_version: '2019.4.1f1' },
        { file_path: pack, assets_only: null, editor_version: null },
      ]),
    );
    expect(containers).toHaveLength(4);
    // The root container holds only its own Assets/, not the project or package files.
    const rootFiles = rows(
      db,
      'SELECT u.rel_path FROM unity_assets u JOIN assets a ON a.id = u.container_id WHERE a.file_path = ?',
      root,
    );
    expect(rootFiles).toEqual([{ rel_path: 'Assets/Fx.mat' }]);
    (db as unknown as { close(): void }).close();
  });

  it('answers on a database from before the Unity follow-up migrations', async () => {
    const db = createTestDb();
    db.exec('ALTER TABLE assets ADD COLUMN has_local_thumbnail INTEGER NOT NULL DEFAULT 0');
    for (const file of MIGRATIONS.slice(0, 3)) db.exec(readFileSync(resolve(file), 'utf8'));
    db.exec(`INSERT INTO assets (id, name, file_path, asset_type, file_size, file_size_is_partial,
        created_date, modified_date, scan_location_id, is_favorite)
      VALUES (1, 'Old', '/old', 'unity_project', 0, 0, '', '', 7, 0);
      INSERT INTO unity_projects (asset_id, root_path, scanned_at) VALUES (1, '/old', '');
      INSERT INTO unity_assets (container_id, guid, rel_path, name, kind)
        VALUES (1, '${'a'.repeat(32)}', 'Assets/A.mat', 'A.mat', 'material');
      INSERT INTO unity_refs VALUES (1, '${'a'.repeat(32)}', '${'b'.repeat(32)}');`);
    // @ts-expect-error -- the Oracle server is plain .mjs with no type declarations.
    const { createUnityTools } = await import('../../../../../scripts/oracle-mcp/unity-tools.mjs');
    const tools = createUnityTools(db);
    expect(tools.call('unity_projects', {})).toContain('PROJECT Old');
    expect(tools.call('unity_projects', {})).toContain('assets used from outside: 1 not found');
    expect(tools.call('unity_dependencies', { asset: 'A.mat' })).toContain(
      `guid ${'b'.repeat(32)}`,
    );
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

  it('records the Asset Store identity, and backfills it on an unchanged rescan', async () => {
    const db = unityDb();
    const { root, pack, thumbs } = library();
    dirs.push(thumbs);
    const signal = new AbortController().signal;
    await scanUnityLocation(db, 7, root, signal, thumbs);
    const store = () =>
      rows(
        db,
        `SELECT p.store_id, p.store_title, p.store_publisher, p.store_category, p.store_version,
                p.store_unity_version, p.store_published_on, a.display_title
           FROM unity_packages p JOIN assets a ON a.id = p.asset_id WHERE a.file_path = ?`,
        pack,
      )[0];
    expect(store()).toEqual({
      store_id: '102321',
      store_title: 'POLYGON - Fleet',
      store_publisher: 'Synty Studios',
      store_category: '3D/Vehicles/Sea',
      store_version: '1.4.0',
      store_unity_version: '2022.3.62f2',
      store_published_on: '07 Oct 2026',
      display_title: 'POLYGON - Fleet',
    });
    const search = rows(db, 'SELECT scan_search_text FROM assets WHERE file_path = ?', pack)[0];
    expect(String(search.scan_search_text)).toContain('Synty Studios');

    // A library indexed before the store columns existed: the archive is unchanged, so it
    // is not re-read, but the header is.
    db.exec('UPDATE unity_packages SET store_id = NULL, store_title = NULL');
    await scanUnityLocation(db, 7, root, signal, thumbs);
    expect(store()?.store_id).toBe('102321');
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
    const { root, project, thumbs } = library();
    dirs.push(thumbs);
    const chapter = join(project, 'c05', 'Assets');
    mkdirSync(chapter, { recursive: true });
    writeFileSync(join(chapter, 'Fx.mat.meta'), `fileFormatVersion: 2\nguid: ${'6'.repeat(32)}\n`);
    writeFileSync(join(chapter, 'Fx.mat'), '%YAML 1.1\nMaterial:\n  m_Name: Fx\n');
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
      expect(projects).toContain(
        `ASSETS FOLDER c05 — inside project ${project}, Unity 6000.3.0f1, urp`,
      );
      expect(projects).toContain('PACKAGE POLYGON Fleet');
      expect(projects).toContain(
        'Asset Store 102321: POLYGON - Fleet by Synty Studios (3D/Vehicles/Sea), v1.4.0, ' +
          'Unity 2022.3.62f2, published 07 Oct 2026',
      );

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

      // References into Unity's own packages name the package; the rest say not found.
      const water = await ask('unity_dependencies', { asset: 'Water.mat' });
      expect(water).toContain(
        'Unity package com.unity.render-pipelines.universal: Shaders/Lit.shader',
      );
      expect(water).toContain(
        'Unity package com.unity.render-pipelines.universal: Textures/BlueNoise16/L/LDR_LLL1_9.png',
      );
      expect(water).toContain(
        `guid ${PACKAGE_GUID.missing} (not found: missing, or from content not scanned)`,
      );
      expect(projects).toContain(
        'assets used from outside: 2 in Unity packages (render-pipelines.universal 2); 1 not found',
      );

      const twoWords = await ask('unity_find_asset', { query: 'prefabs ship variant' });
      expect(twoWords.trim().split('\n')).toEqual([
        expect.stringContaining('Assets/Prefabs/Ship Variant.prefab'),
      ]);

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
