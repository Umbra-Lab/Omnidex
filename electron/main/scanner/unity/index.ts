import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import type { Database } from 'better-sqlite3';
import { pruneAssetsNotIn } from '../../db/repos/assets';
import { type AssetStoreInfo, readAssetStoreInfo } from './asset-store';
import {
  discoverUnity,
  listProjectFiles,
  readMetaGuid,
  readPackageCache,
  readProjectFile,
  readProjectInfo,
  repairZipName,
  type UnityProjectInfo,
} from './project';
import { readUnityPackage, type UnityPackageContents } from './unitypackage';

/**
 * Scan a `scan_mode = 'unity'` location: every Unity project and `.unitypackage` under
 * the root becomes one row in `assets`, and what is inside it goes to `unity_assets` and
 * `unity_refs`. Files are read, never written; the only file Omnidex creates is a
 * package's preview thumbnail under its own userData.
 *
 * Projects rescan incrementally: a file whose size and modification time (and its
 * .meta's) are unchanged keeps its stored row. Packages are re-read only when the
 * package file itself changed.
 */

export interface UnityScanResult {
  total: number;
  existing: number;
  projects: number;
  packages: number;
  failures: string[];
}

export async function scanUnityLocation(
  db: Database,
  locationId: number,
  root: string,
  signal: AbortSignal,
  thumbnailRoot: string,
): Promise<UnityScanResult> {
  const found = await discoverUnity(root, signal);
  const existingStmt = db.prepare('SELECT 1 FROM assets WHERE file_path = ?');
  const seen: string[] = [];
  const failures: string[] = [];
  const failedPaths: string[] = [];
  let existing = 0;

  for (const projectRoot of found.projects) {
    signal.throwIfAborted();
    if (existingStmt.get(projectRoot)) existing += 1;
    try {
      await indexUnityProject(db, locationId, projectRoot, signal);
      seen.push(projectRoot);
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${projectRoot}: ${(error as Error).message}`);
      failedPaths.push(projectRoot);
    }
  }
  for (const folder of found.assetFolders) {
    signal.throwIfAborted();
    if (existingStmt.get(folder.root)) existing += 1;
    try {
      await indexUnityProject(db, locationId, folder.root, signal, {
        settingsFrom: folder.project,
      });
      seen.push(folder.root);
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${folder.root}: ${(error as Error).message}`);
      failedPaths.push(folder.root);
    }
  }
  for (const packagePath of found.packages) {
    signal.throwIfAborted();
    if (existingStmt.get(packagePath)) existing += 1;
    try {
      await indexUnityPackage(db, locationId, packagePath, signal, thumbnailRoot);
      seen.push(packagePath);
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${packagePath}: ${(error as Error).message}`);
      failedPaths.push(packagePath);
    }
  }

  // A container that failed to read this time is kept, not pruned: the failure is more
  // likely a locked file than a deleted one. So is anything under a folder that could
  // not be listed.
  const keep = [...seen, ...failedPaths];
  if (found.unreadable.length > 0) {
    const indexed = db
      .prepare('SELECT file_path FROM assets WHERE scan_location_id = ?')
      .all(locationId) as Array<{ file_path: string }>;
    for (const { file_path } of indexed) {
      // A container at an unreadable folder, or under one, may well still be there.
      const under = (dir: string) => file_path === dir || file_path.startsWith(dir + sep);
      if (found.unreadable.some(under)) keep.push(file_path);
    }
    failures.push(...found.unreadable.map((dir) => `${dir}: could not be listed`));
  }
  db.exec('BEGIN');
  try {
    // pruneAssetsNotIn treats an empty list as "nothing was seen, prune nothing", a guard
    // for walks that fail silently. Discovery here throws when the root is unreadable, so
    // an empty result really means every project and package is gone.
    pruneAssetsNotIn(db, locationId, keep.length > 0 ? keep : ['\0']);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    total: found.projects.length + found.assetFolders.length + found.packages.length,
    existing,
    projects: found.projects.length + found.assetFolders.length,
    packages: found.packages.length,
    failures,
  };
}

const ASSET_UPSERT = `INSERT INTO assets
  (name, file_path, asset_type, file_size, file_size_is_partial, created_date, modified_date,
   scan_location_id, is_favorite, ecosystem, asset_ecosystem, content_format, scan_search_text)
  VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0, 'unity', 'unity', NULL, ?)
  ON CONFLICT(file_path) DO UPDATE SET name=excluded.name, asset_type=excluded.asset_type,
    file_size=excluded.file_size, modified_date=excluded.modified_date,
    ecosystem=excluded.ecosystem, asset_ecosystem=excluded.asset_ecosystem,
    scan_search_text=excluded.scan_search_text, missing_since=NULL`;

/** Insert or refresh the container row; refuse a path another location owns. */
function upsertContainer(
  db: Database,
  locationId: number,
  fields: { name: string; path: string; type: string; size: number; searchText: string },
): number {
  const owner = db
    .prepare('SELECT id, scan_location_id FROM assets WHERE file_path = ?')
    .get(fields.path) as { id: number; scan_location_id: number } | undefined;
  if (owner && owner.scan_location_id !== locationId) {
    throw new Error('path belongs to another scan location');
  }
  const now = new Date().toISOString();
  db.prepare(ASSET_UPSERT).run(
    fields.name,
    fields.path,
    fields.type,
    fields.size,
    now,
    now,
    locationId,
    fields.searchText,
  );
  const row = db.prepare('SELECT id FROM assets WHERE file_path = ?').get(fields.path) as {
    id: number;
  };
  return row.id;
}

/** Record (or clear) a package's Asset Store identity; its store title also names the card. */
function writeStoreInfo(db: Database, containerId: number, store: AssetStoreInfo | null): void {
  db.prepare(
    `UPDATE unity_packages SET store_id = ?, store_title = ?, store_publisher = ?,
       store_category = ?, store_version = ?, store_unity_version = ?, store_published_on = ?
     WHERE asset_id = ?`,
  ).run(
    store?.id ?? null,
    store?.title ?? null,
    store?.publisher ?? null,
    store?.category ?? null,
    store?.version ?? null,
    store?.unityVersion ?? null,
    store?.publishedOn ?? null,
    containerId,
  );
  if (store?.title) {
    db.prepare('UPDATE assets SET display_title = ? WHERE id = ? AND display_title IS NULL').run(
      store.title,
      containerId,
    );
  }
}

function searchText(parts: Array<string | null | undefined>): string {
  return parts
    .filter(Boolean)
    .join(' ')
    .replaceAll(/[_./@-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

interface StoredRow {
  id: number;
  guid: string | null;
  size: number;
  mtime_ms: number;
}

interface FreshRow {
  guid: string | null;
  relPath: string;
  name: string;
  kind: string;
  size: number;
  mtimeMs: number;
  serialization: 'text' | 'binary' | 'none';
  variantOf: string | null;
  summary: string | null;
  refs: string[];
}

/**
 * Index a Unity project, or an Assets/ folder with no ProjectSettings/ of its own
 * (`assetsOnly`). Such a folder borrows the Editor version, pipeline and packages of the
 * project it sits inside (`settingsFrom`), or has none when it stands alone.
 */
export async function indexUnityProject(
  db: Database,
  locationId: number,
  projectRoot: string,
  signal?: AbortSignal,
  options: { settingsFrom?: string | null } = {},
): Promise<{ containerId: number; info: UnityProjectInfo; changed: number; files: number }> {
  const assetsOnly = options.settingsFrom !== undefined;
  const settingsFrom = options.settingsFrom ?? null;
  let info = await readProjectInfo(settingsFrom ?? projectRoot);
  if (assetsOnly) {
    const own = await readProjectInfo(projectRoot);
    info = settingsFrom
      ? { ...info, name: own.name, root: projectRoot }
      : // With no manifest of its own, the pipeline cannot be told.
        {
          ...own,
          renderPipeline: Object.keys(own.packages).length ? own.renderPipeline : 'unknown',
        };
  }
  const files = await listProjectFiles(projectRoot, signal);
  if (!assetsOnly) await learnPackageCache(db, projectRoot, signal);
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  const prior = db.prepare('SELECT id FROM assets WHERE file_path = ?').get(projectRoot) as
    | { id: number }
    | undefined;
  const stored = new Map<string, StoredRow>();
  if (prior) {
    const rows = db
      .prepare('SELECT id, rel_path, guid, size, mtime_ms FROM unity_assets WHERE container_id = ?')
      .all(prior.id) as Array<StoredRow & { rel_path: string }>;
    for (const row of rows) stored.set(row.rel_path, row);
  }

  // References are stored per GUID. When a file changes or goes away, every other file
  // with the same GUID (a copy duplicated outside Unity) is reread too, so its references
  // are rebuilt rather than lost with the changed file's.
  const byPath = new Map(files.map((file) => [file.relPath, file]));
  const isChanged = (file: (typeof files)[number]) => {
    const before = stored.get(file.relPath);
    return !before || before.size !== file.size || before.mtime_ms !== file.mtimeMs;
  };
  const touchedGuids = new Set<string>();
  for (const [relPath, row] of stored) {
    if (!row.guid) continue;
    const file = byPath.get(relPath);
    if (!file || isChanged(file)) touchedGuids.add(row.guid);
  }

  // Read changed files before taking the write transaction, so the app stays responsive.
  const fresh: FreshRow[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const before = stored.get(file.relPath);
    const twin = before?.guid ? touchedGuids.has(before.guid) : false;
    if (!isChanged(file) && !twin) continue;
    const guid = await readMetaGuid(file.absPath);
    const contents = await readProjectFile(file, guid);
    fresh.push({
      guid,
      relPath: file.relPath,
      name: file.name,
      kind: file.kind === 'prefab' && contents.variantOf ? 'prefab_variant' : file.kind,
      size: file.size,
      // A read that failed is stored with no timestamp, so the next scan retries it.
      mtimeMs: contents.failed ? 0 : file.mtimeMs,
      serialization: contents.serialization,
      variantOf: contents.variantOf,
      summary: contents.outline ? JSON.stringify(contents.outline) : null,
      refs: contents.refs,
    });
  }
  const removed = [...stored.entries()].filter(([relPath]) => !byPath.has(relPath));

  db.exec('BEGIN');
  try {
    const containerId = upsertContainer(db, locationId, {
      name: info.name,
      path: projectRoot,
      type: 'unity_project',
      size: totalSize,
      searchText: searchText([
        info.name,
        assetsOnly ? 'unity assets folder' : 'unity project',
        settingsFrom ? repairZipName(basename(settingsFrom)) : null,
        info.editorVersion,
        info.renderPipeline,
        ...Object.keys(info.packages),
      ]),
    });
    db.prepare(
      `INSERT INTO unity_projects
        (asset_id, root_path, editor_version, render_pipeline, packages_json, scanned_at,
         assets_only, settings_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET root_path=excluded.root_path,
          editor_version=excluded.editor_version, render_pipeline=excluded.render_pipeline,
          packages_json=excluded.packages_json, scanned_at=excluded.scanned_at,
          assets_only=excluded.assets_only, settings_from=excluded.settings_from`,
    ).run(
      containerId,
      projectRoot,
      info.editorVersion,
      info.renderPipeline,
      JSON.stringify(info.packages),
      new Date().toISOString(),
      assetsOnly ? 1 : 0,
      settingsFrom,
    );
    const deleteRow = db.prepare('DELETE FROM unity_assets WHERE id = ?');
    const deleteRefs = db.prepare(
      'DELETE FROM unity_refs WHERE container_id = ? AND from_guid = ?',
    );
    for (const [, row] of removed) {
      deleteRow.run(row.id);
      if (row.guid) deleteRefs.run(containerId, row.guid);
    }
    for (const row of fresh) {
      const before = stored.get(row.relPath);
      if (before?.guid) deleteRefs.run(containerId, before.guid);
    }
    writeRows(db, containerId, fresh);
    db.exec('COMMIT');
    return { containerId, info, changed: fresh.length + removed.length, files: files.length };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Record which Unity package owns each GUID in the project's Library/PackageCache, so
 * references into URP, uGUI and the rest name the package instead of looking missing.
 * Each package version is read once, from whichever project has it first. A failure
 * here costs only the names, so it never fails the project's scan.
 */
async function learnPackageCache(
  db: Database,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const seen = db.prepare(
    'SELECT 1 FROM unity_package_cache_seen WHERE package = ? AND version = ?',
  );
  let found: Awaited<ReturnType<typeof readPackageCache>>;
  try {
    found = await readPackageCache(
      projectRoot,
      (name, version) => seen.get(name, version) !== undefined,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return;
  }
  if (found.length === 0) return;
  // A seed row (version NULL) gives way to a learned one; a learned row stays put.
  const insert = db.prepare(
    `INSERT INTO unity_known_guids (guid, package, version, rel_path) VALUES (?, ?, ?, ?)
       ON CONFLICT(guid) DO UPDATE SET package = excluded.package, version = excluded.version,
         rel_path = excluded.rel_path
       WHERE unity_known_guids.version IS NULL`,
  );
  const markSeen = db.prepare(
    'INSERT OR IGNORE INTO unity_package_cache_seen (package, version) VALUES (?, ?)',
  );
  db.exec('BEGIN');
  try {
    for (const entry of found) {
      for (const [guid, relPath] of entry.guids) {
        insert.run(guid, entry.package, entry.version, relPath);
      }
      if (entry.complete) markSeen.run(entry.package, entry.version);
    }
    db.exec('COMMIT');
  } catch {
    // Only the package names are lost; the project itself still indexes.
    db.exec('ROLLBACK');
  }
}

function writeRows(db: Database, containerId: number, rows: FreshRow[]): void {
  const upsert = db.prepare(
    `INSERT INTO unity_assets
      (container_id, guid, rel_path, name, kind, size, mtime_ms, serialization, variant_of,
       summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(container_id, rel_path) DO UPDATE SET guid=excluded.guid, name=excluded.name,
        kind=excluded.kind, size=excluded.size, mtime_ms=excluded.mtime_ms,
        serialization=excluded.serialization, variant_of=excluded.variant_of,
        summary_json=excluded.summary_json`,
  );
  const insertRef = db.prepare(
    'INSERT OR IGNORE INTO unity_refs (container_id, from_guid, to_guid) VALUES (?, ?, ?)',
  );
  for (const row of rows) {
    upsert.run(
      containerId,
      row.guid,
      row.relPath,
      row.name,
      row.kind,
      row.size,
      row.mtimeMs,
      row.serialization,
      row.variantOf,
      row.summary,
    );
    if (row.guid) for (const to of row.refs) insertRef.run(containerId, row.guid, to);
  }
}

export async function indexUnityPackage(
  db: Database,
  locationId: number,
  packagePath: string,
  signal: AbortSignal | undefined,
  thumbnailRoot: string,
): Promise<{ containerId: number; reread: boolean }> {
  const info = await stat(packagePath);
  const mtimeMs = Math.trunc(info.mtimeMs);
  const prior = db
    .prepare(
      `SELECT a.id, p.file_size, p.file_mtime_ms, a.thumbnail_path FROM assets a
        LEFT JOIN unity_packages p ON p.asset_id = a.id WHERE a.file_path = ?`,
    )
    .get(packagePath) as
    | {
        id: number;
        file_size: number | null;
        file_mtime_ms: number | null;
        thumbnail_path: string | null;
      }
    | undefined;
  // One small read, done even for an unchanged package so a library indexed before this
  // field was read picks it up without re-reading every archive.
  const store = await readAssetStoreInfo(packagePath).catch(() => null);
  if (prior && prior.file_size === info.size && prior.file_mtime_ms === mtimeMs) {
    writeStoreInfo(db, prior.id, store);
    return { containerId: prior.id, reread: false };
  }

  const contents: UnityPackageContents = await readUnityPackage(packagePath, signal);
  const name = basename(packagePath, extname(packagePath));
  let thumbnail: string | null = null;
  if (contents.preview && !prior?.thumbnail_path) {
    const dir = join(thumbnailRoot, 'unity');
    await mkdir(dir, { recursive: true });
    thumbnail = join(dir, `${createHash('sha1').update(packagePath).digest('hex')}.png`);
    await writeFile(thumbnail, contents.preview);
  }
  const folders = new Set(
    contents.entries.map((entry) => entry.relPath.split('/').slice(1, 3).join(' ')),
  );

  db.exec('BEGIN');
  try {
    const containerId = upsertContainer(db, locationId, {
      name,
      path: packagePath,
      type: 'unity_package',
      size: info.size,
      searchText: searchText([
        name,
        'unity package',
        store?.title,
        store?.publisher,
        store?.category,
        ...folders,
      ]),
    });
    if (thumbnail) {
      db.prepare('UPDATE assets SET thumbnail_path = ?, has_local_thumbnail = 1 WHERE id = ?').run(
        thumbnail,
        containerId,
      );
    }
    db.prepare(
      `INSERT INTO unity_packages (asset_id, file_size, file_mtime_ms, scanned_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET file_size=excluded.file_size,
          file_mtime_ms=excluded.file_mtime_ms, scanned_at=excluded.scanned_at`,
    ).run(containerId, info.size, mtimeMs, new Date().toISOString());
    writeStoreInfo(db, containerId, store);
    db.prepare('DELETE FROM unity_assets WHERE container_id = ?').run(containerId);
    db.prepare('DELETE FROM unity_refs WHERE container_id = ?').run(containerId);
    writeRows(
      db,
      containerId,
      contents.entries.map((entry) => ({
        guid: entry.guid,
        relPath: entry.relPath,
        name: entry.name,
        kind: entry.kind,
        size: entry.size,
        mtimeMs: 0,
        serialization: entry.serialization,
        variantOf: entry.variantOf,
        summary: entry.outline ? JSON.stringify(entry.outline) : null,
        refs: entry.refs,
      })),
    );
    db.exec('COMMIT');
    return { containerId, reread: true };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
