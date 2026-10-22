import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ScanDiagnostic } from '@omnidex/types/db';
import type { Database, Statement } from 'better-sqlite3';
import { BrowserWindow } from 'electron';
import { openDatabase } from '../db';
import { thumbnailsDir } from '../db/paths';
import { assetsRepo, coursesRepo, scanDiagnosticsRepo, scanLocationsRepo } from '../db/repos';
import { ASSET_UPSERT_SQL } from './asset-upsert';
import {
  buildCourseManifest,
  deriveCourseTitle,
  detectTutorialSource,
  parseCues,
} from './course-manifest';
import { findThumbnailSource } from './thumbnail-finder';
import { extractThumbnailsIsolated } from './thumbnail-pool';
import type { DetectedAssetFolder } from './walker';
import { WALK_DIAGNOSTIC_KINDS, walkRootWithDiagnostics } from './walker';

/**
 * Scan-progress payload. Shape mirrors `src-tauri/src/models/scan_location.rs`
 * `ScanProgress` so the renderer's `scanningStore` event handler accepts both
 * runtimes without branching.
 */
export interface ScanProgressPayload {
  location_id: number;
  location_name: string | null;
  location_path: string | null;
  status: string;
  current_path: string;
  processed_items: number;
  total_items: number;
  completed_successfully: boolean;
  error: string | null;
  current_location_index: number | null;
  total_locations: number | null;
  cumulative_items_processed: number | null;
  error_count: number | null;
  new_assets_count: number | null;
  existing_assets_count: number | null;
}

const activeScans = new Map<number, AbortController>();

function emit(payload: ScanProgressPayload): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('scan-progress', payload);
  }
}

/**
 * Launch a scan for the given location. Idempotent — a second call for an
 * already-scanning location returns immediately.
 *
 * Walks top-level subfolders, upserts a stub asset row per folder, reconciles
 * against what is still on disk, and emits a single `scan-progress` event on
 * completion.
 */
export async function startScan(locationId: number): Promise<ScanProgressPayload> {
  if (activeScans.has(locationId)) {
    return completionPayload(locationId, null, null, 0, 0, 0, 'already running');
  }

  const controller = new AbortController();
  activeScans.set(locationId, controller);

  const db = openDatabase();
  const location = scanLocationsRepo.getScanLocation(db, locationId);
  if (!location) {
    activeScans.delete(locationId);
    throw new Error(`Scan location ${locationId} not found`);
  }

  // Intentionally silent during the foreground scan. The renderer's
  // statusBarStore, scanningStore, and refreshService all react to
  // `scan-progress` events by writing Svelte runes state. With the scan
  // completing in under a second for typical libraries, multiple rapid
  // events caused `effect_update_depth_exceeded` cascades that crashed
  // the window. Emitting only the final `Completed` event ensures the
  // UI refreshes exactly once, after the DB is fully populated.

  // `content_format` comes from the location, not the folder: it routes these
  // rows to Learn instead of the pack library, and it selects the flat walk.
  const contentFormat = location.content_format ?? null;

  const t0 = Date.now();
  console.log(`[scan] walking ${location.path}`);
  let folders: DetectedAssetFolder[] = [];
  let diagnostics: ScanDiagnostic[] = [];
  try {
    // A content location (Courses) holds one course per top-level folder.
    // Pack detection would descend into each course's sample projects and
    // register those as courses too.
    ({ folders, diagnostics } = await walkRootWithDiagnostics(location.path, {
      flat: contentFormat != null,
    }));
  } catch (err) {
    activeScans.delete(locationId);
    const payload = errorPayload(locationId, location.name, location.path, (err as Error).message);
    emit(payload);
    return payload;
  }

  const tWalk = Date.now();
  console.log(
    `[scan] walk done: ${folders.length} folders in ${((tWalk - t0) / 1000).toFixed(1)}s`,
  );
  const total = folders.length;
  let processed = 0;
  let newAssets = 0;
  let existingAssets = 0;

  const upsert = db.prepare(ASSET_UPSERT_SQL);
  const existsStmt = db.prepare('SELECT 1 AS present FROM assets WHERE file_path = ? LIMIT 1');
  const thumbStmt = db.prepare(
    'UPDATE assets SET thumbnail_path = ?, has_local_thumbnail = 1 WHERE file_path = ?',
  );
  const needsThumbStmt = db.prepare(
    'SELECT thumbnail_path FROM assets WHERE file_path = ? LIMIT 1',
  );
  const thumbnailRoot = thumbnailsDir();

  // Track folders that need thumbnail extraction after the synchronous
  // upsert pass completes. Running extraction inline would serialize each
  // scan on binary-parse + image-decode time; instead we batch them with
  // bounded concurrency below.
  const thumbnailTargets: string[] = [];
  // Every folder path observed this scan. Drives the reconciliation prune
  // below so rows for packs that disappeared from disk get cleaned up.
  const seenPaths: string[] = [];
  let pruned = 0;

  // Wrap the per-folder upsert loop (and the reconciliation prune) in a single
  // transaction. Previously each `upsert.run` committed on its own — one WAL
  // commit per pack — and a crash mid-scan could leave the prune half-applied.
  // Using raw BEGIN/COMMIT/ROLLBACK (not `db.transaction()`) keeps the same
  // code path working under the `node:sqlite` engine the repo tests run on.
  db.exec('BEGIN');
  try {
    for (const folder of folders) {
      if (controller.signal.aborted) break;

      const existed = existsStmt.get(folder.absolutePath) !== undefined;
      const now = new Date().toISOString();
      const assetType = folder.hasUassetFiles ? 'unreal_pack' : 'folder';
      upsert.run(
        folder.name,
        folder.absolutePath,
        assetType,
        folder.fileSize,
        folder.sizeIsPartial ? 1 : 0,
        now,
        now,
        locationId,
        folder.ecosystem,
        folder.ecosystem,
        contentFormat,
      );
      seenPaths.push(folder.absolutePath);
      if (existed) existingAssets += 1;
      else newAssets += 1;
      processed += 1;

      // Queue thumbnail extraction for any pack that doesn't yet have one —
      // not just UE packs. Folders with no `.uasset` fall back to a preview
      // image shipped in the pack (see `findThumbnailSource`), which is the
      // only thumbnail an FBX/OBJ/Blend-source pack can ever have.
      // Preserves existing thumbnails on re-scan (cheap path).
      const row = needsThumbStmt.get(folder.absolutePath) as
        | { thumbnail_path: string | null }
        | undefined;
      if (!row?.thumbnail_path) {
        thumbnailTargets.push(folder.absolutePath);
      }

      // See note above `const t0 = Date.now()` — no mid-scan emits.
    }

    // Reconciliation prune: drop rows for packs that vanished from disk. Only
    // safe on a COMPLETE walk — an aborted scan has a partial `seenPaths` set
    // and would wrongly delete live rows, so skip the prune when aborted.
    if (!controller.signal.aborted) {
      pruned = assetsRepo.pruneAssetsNotIn(db, locationId, seenPaths);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Course manifests. Only for content locations, and only after the upsert
  // pass so every course has a row to hang files off. Runs outside the scan
  // transaction: it opens one file handle per video to read the MP4 header,
  // which is slow enough that holding a write lock through it would block the
  // UI's reads for the whole pass.
  if (contentFormat != null && !controller.signal.aborted) {
    await indexCourseManifests(db, locationId, seenPaths);
  }

  // Record what the walk could not index. Skipped on an aborted scan — a
  // partial walk's diagnostics would understate the real total and replacing
  // the previous scan's rows with them loses information.
  if (!controller.signal.aborted) {
    scanDiagnosticsRepo.replaceForLocation(db, locationId, WALK_DIAGNOSTIC_KINDS, diagnostics);
    console.log(`[scan] diagnostics: ${diagnostics.length} recorded`);
  }

  const tInsert = Date.now();
  console.log(
    `[scan] inserts done: ${processed} rows (${newAssets} new, ${existingAssets} existing, ${pruned} pruned) in ${((tInsert - tWalk) / 1000).toFixed(1)}s`,
  );

  // Kick thumbnails into a fire-and-forget background task so startScan()
  // returns to the renderer immediately. Each thumbnail ticks a
  // `scan-progress` event so the grid can live-update as PNGs are written.
  if (!controller.signal.aborted && thumbnailTargets.length > 0) {
    console.log(`[scan] backgrounding ${thumbnailTargets.length} thumbnail extractions`);
    // Fire-and-forget, but never leave the promise unhandled: a rejection here
    // (e.g. an unexpected throw outside the per-pack try/catch) would otherwise
    // surface as an `unhandledRejection`. Swallow-and-log so the background job
    // can fail without crashing the process; the foreground scan already
    // returned and the grid falls back to default icons.
    void backgroundThumbnails({
      db,
      locationId,
      locationName: location.name,
      locationPath: location.path,
      targets: thumbnailTargets,
      thumbnailRoot,
      thumbStmt,
      controller,
      total,
    }).catch((err) => {
      console.error('[scan] background thumbnail job failed:', (err as Error).message);
    });
  }

  const tDone = Date.now();
  console.log(
    `[scan] foreground complete: ${((tDone - t0) / 1000).toFixed(1)}s total ` +
      `(walk=${((tWalk - t0) / 1000).toFixed(1)}s insert=${((tInsert - tWalk) / 1000).toFixed(1)}s). ` +
      `Thumbnails run asynchronously in background.`,
  );

  activeScans.delete(locationId);
  const summary = completionPayload(
    locationId,
    location.name,
    location.path,
    processed,
    newAssets,
    existingAssets,
    null,
  );
  emit(summary);
  return summary;
}

export function cancelScan(locationId: number): boolean {
  const controller = activeScans.get(locationId);
  if (!controller) return false;
  controller.abort();
  activeScans.delete(locationId);
  return true;
}

export function activeScanCount(): number {
  return activeScans.size;
}

interface BackgroundThumbnailArgs {
  db: Database;
  locationId: number;
  locationName: string;
  locationPath: string;
  targets: string[];
  thumbnailRoot: string;
  thumbStmt: Statement<[string, string]>;
  controller: AbortController;
  total: number;
}

/**
 * Thumbnail extraction runs after `startScan` returns. Bounded concurrency,
 * hard 10s per-pack timeout via `Promise.race` so a single malformed
 * `.uasset` can't stall the whole batch. Errors per pack are swallowed —
 * the UI falls back to a default folder icon.
 */
async function backgroundThumbnails(args: BackgroundThumbnailArgs): Promise<void> {
  const {
    db,
    locationId,
    locationName,
    locationPath,
    targets,
    thumbnailRoot,
    thumbStmt,
    controller,
    total,
  } = args;
  const CONCURRENCY = 4;
  const PER_PACK_TIMEOUT_MS = 10_000;
  const EMIT_EVERY = 8;
  const t0 = Date.now();
  let processed = 0;
  // Per-pack failures are still swallowed (the grid falls back to a folder
  // icon) but no longer silent — each one is recorded with its cause so the
  // Library Health view can say *why* a card is blank.
  const failures: ScanDiagnostic[] = [];

  // Phase 1 — decide each pack's source. Pure filesystem reads, no addon, so
  // nothing here can take the process down.
  const uassetPacks = new Map<string, string[]>();
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (controller.signal.aborted) break;
    await Promise.all(
      targets.slice(i, i + CONCURRENCY).map(async (folderPath) => {
        const source = await findThumbnailSource(folderPath).catch(() => null);
        if (!source) {
          failures.push({
            kind: 'thumbnail-failed',
            path: folderPath,
            detail: 'no .uasset or preview image found near the pack root',
          });
          processed += 1;
          return;
        }
        // A plain image is already displayable — the renderer streams it over
        // `omnidex-asset://` straight from the pack folder. Only a .uasset
        // needs the native extractor.
        if (source.kind === 'image') {
          thumbStmt.run(source.path, folderPath);
          processed += 1;
          return;
        }
        // Nested packs can resolve to the same `.uasset`; one extraction serves
        // all of them.
        const packs = uassetPacks.get(source.path) ?? [];
        packs.push(folderPath);
        uassetPacks.set(source.path, packs);
      }),
    );
  }

  // Phase 2 — the part that can die. See `thumbnail-pool` for why it is not
  // called in-process.
  await extractThumbnailsIsolated({
    targets: [...uassetPacks.keys()],
    outDir: thumbnailRoot,
    size: 256,
    concurrency: CONCURRENCY,
    timeoutMs: PER_PACK_TIMEOUT_MS,
    signal: controller.signal,
    onResult: (uassetPath, png) => {
      for (const folderPath of uassetPacks.get(uassetPath) ?? []) {
        if (png) {
          thumbStmt.run(png, folderPath);
        } else {
          failures.push({
            kind: 'thumbnail-failed',
            path: folderPath,
            detail: `extraction from ${uassetPath} produced no image (unsupported format, or it timed out after ${PER_PACK_TIMEOUT_MS / 1000}s)`,
          });
        }
        processed += 1;
      }
    },
    onCrash: (uassetPath) => {
      // Worth naming precisely: this file is not merely unsupported, it aborts
      // the extractor, and in-process it used to abort the entire scan.
      console.warn(`[scan] thumbnail extractor crashed on ${uassetPath} — skipped`);
      for (const folderPath of uassetPacks.get(uassetPath) ?? []) {
        failures.push({
          kind: 'thumbnail-failed',
          path: folderPath,
          detail: `${uassetPath} crashes the .uasset extractor (malformed header); isolated and skipped`,
        });
      }
    },
  });

  // Intentionally no per-batch emit. Thumbnails populate via DB writes, which
  // any asset grid re-fetch picks up. Emitting here during the backgrounded
  // extraction caused cascading Svelte effect loops in the renderer
  // (refreshService → fetchAll → store update → effect → ...).
  void EMIT_EVERY;

  console.log(
    `[scan] thumbnails done: ${processed}/${targets.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(${failures.length} failed)`,
  );
  // Replaced wholesale: this job just re-attempted every pack still missing a
  // thumbnail, so its failure set is the complete current picture for this kind.
  if (!controller.signal.aborted) {
    scanDiagnosticsRepo.replaceForLocation(db, locationId, ['thumbnail-failed'], failures);
  }
  emit({
    location_id: locationId,
    location_name: locationName,
    location_path: locationPath,
    status: 'ThumbnailsComplete',
    current_path: '',
    processed_items: total,
    total_items: total,
    completed_successfully: true,
    error: null,
    current_location_index: 0,
    total_locations: 1,
    cumulative_items_processed: total,
    error_count: 0,
    new_assets_count: null,
    existing_assets_count: null,
  });
}

// ---------------------------------------------------------------------------

function completionPayload(
  locationId: number,
  locationName: string | null,
  locationPath: string | null,
  processed: number,
  newAssets: number,
  existingAssets: number,
  note: string | null,
): ScanProgressPayload {
  return {
    location_id: locationId,
    location_name: locationName,
    location_path: locationPath,
    status: 'Completed',
    current_path: locationPath ?? '',
    processed_items: processed,
    total_items: processed,
    completed_successfully: true,
    error: note,
    current_location_index: 0,
    total_locations: 1,
    cumulative_items_processed: processed,
    error_count: 0,
    new_assets_count: newAssets,
    existing_assets_count: existingAssets,
  };
}

function errorPayload(
  locationId: number,
  locationName: string,
  locationPath: string,
  message: string,
): ScanProgressPayload {
  return {
    location_id: locationId,
    location_name: locationName,
    location_path: locationPath,
    status: 'Error',
    current_path: locationPath,
    processed_items: 0,
    total_items: 0,
    completed_successfully: false,
    error: message,
    current_location_index: 0,
    total_locations: 1,
    cumulative_items_processed: 0,
    error_count: 1,
    new_assets_count: 0,
    existing_assets_count: 0,
  };
}

// Mark parameters that would otherwise be flagged unused once the skeleton
// is fleshed out with streaming and worker-pool logic. Keeping the import
// here prevents `noUnusedParameters` from complaining about future branches.
export type { Database };

/**
 * Walk each course folder, write its manifest, and index any subtitles.
 *
 * Separate pass, deliberately: reading MP4 headers is one file open per video
 * and parsing subtitles is more IO again. Doing it inside the scan transaction
 * would hold a write lock across all of it.
 */
async function indexCourseManifests(
  db: Database,
  locationId: number,
  coursePaths: readonly string[],
): Promise<void> {
  const idOf = db.prepare('SELECT id FROM assets WHERE file_path = ? AND scan_location_id = ?');
  let indexed = 0;
  let cues = 0;

  for (const coursePath of coursePaths) {
    const row = idOf.get(coursePath, locationId) as { id: number } | undefined;
    if (!row) continue;

    let files: Awaited<ReturnType<typeof buildCourseManifest>>;
    try {
      files = await buildCourseManifest(coursePath, {
        readDurations: true,
        knownDurations: coursesRepo.knownDurations(db, row.id),
      });
    } catch {
      // A course we cannot read is not a reason to fail the whole scan.
      continue;
    }

    // Attribute the course while we have its paths in hand. The folder name
    // is the usual signal ("Udemy - ..."); when it is a bare course id the
    // vendor is one level in, which is why the manifest paths are passed too.
    const relPaths = files.map((f) => f.relPath);
    const source = detectTutorialSource(basename(coursePath), relPaths);
    const title = deriveCourseTitle(basename(coursePath), relPaths);
    // Largest image in the course is its cover: real course art outweighs
    // the stray icons and logos that also live in these folders.
    const cover = files
      .filter((f) => f.kind === 'image')
      .sort((a, b) => b.sizeBytes - a.sizeBytes)[0];

    db.exec('BEGIN');
    try {
      coursesRepo.replaceCourseManifest(db, row.id, files);
      if (source) {
        db.prepare('UPDATE assets SET tutorial_source = ? WHERE id = ?').run(source, row.id);
      }
      if (title) {
        db.prepare('UPDATE assets SET display_title = ? WHERE id = ?').run(title, row.id);
      }
      // Fill an empty thumbnail only — never clobber one the uasset
      // extractor or a marketplace match already provided.
      if (cover) {
        db.prepare(
          'UPDATE assets SET thumbnail_path = ?, has_local_thumbnail = 1 WHERE id = ? AND thumbnail_path IS NULL',
        ).run(cover.absPath, row.id);
      }
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
      continue;
    }
    indexed += 1;

    // Subtitles: parse and index. Read after the manifest commit so file ids
    // exist to attach cues to.
    const subtitles = files.filter((f) => f.kind === 'subtitle');
    if (subtitles.length === 0) continue;
    const fileIdOf = db.prepare('SELECT id FROM course_files WHERE asset_id = ? AND rel_path = ?');
    for (const sub of subtitles) {
      const fileRow = fileIdOf.get(row.id, sub.relPath) as { id: number } | undefined;
      if (!fileRow) continue;
      try {
        const text = await readFile(sub.absPath, 'utf8');
        const parsed = parseCues(text);
        if (parsed.length === 0) continue;
        db.exec('BEGIN');
        try {
          coursesRepo.replaceTranscript(db, fileRow.id, parsed);
          db.exec('COMMIT');
          cues += parsed.length;
        } catch {
          db.exec('ROLLBACK');
        }
      } catch {
        // Unreadable or non-UTF8 subtitle: skip this one, keep the course.
      }
    }
  }
  console.log(`[scan] course manifests: ${indexed} indexed, ${cues} transcript cues`);
}
