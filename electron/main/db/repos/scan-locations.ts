import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { ContentFormat, ScanLocation } from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';
import { normalizeRow, normalizeRows, toSqliteBool } from './row-helpers';

export function listScanLocations(db: Database): ScanLocation[] {
  const rows = db.prepare('SELECT * FROM scan_locations ORDER BY created_date ASC').all() as Record<
    string,
    unknown
  >[];
  return normalizeRows<ScanLocation>(rows);
}

export interface ScanLocationStats {
  scan_location_id: number;
  asset_count: number;
  size_bytes: number;
  /** Packs whose size the walker could only measure to a lower bound. */
  partial_count: number;
  last_scan: string | null;
}

/**
 * Per-location totals for the folder list: how much each folder produced and
 * when it was last walked.
 *
 * `last_scan` comes from `MAX(assets.modified_date)`, not from
 * `scan_locations.last_scan` — that column is written once at insert and no
 * scan has ever updated it, whereas the pipeline restamps `modified_date` on
 * every upsert (and nothing else writes that column). Locations that have
 * never produced a row are simply absent from the result.
 */
export function listScanLocationStats(db: Database): ScanLocationStats[] {
  return db
    .prepare(
      `SELECT scan_location_id,
              COUNT(*) AS asset_count,
              COALESCE(SUM(file_size), 0) AS size_bytes,
              COALESCE(SUM(file_size_is_partial), 0) AS partial_count,
              MAX(modified_date) AS last_scan
         FROM assets
        GROUP BY scan_location_id`,
    )
    .all() as ScanLocationStats[];
}

export function getScanLocation(db: Database, id: number): ScanLocation | null {
  const row = db.prepare('SELECT * FROM scan_locations WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return normalizeRow<ScanLocation>(row);
}

/**
 * A folder path in the form two spellings of one folder share. It is resolved
 * (dropping trailing separators and `.`/`..`, and on Windows turning / into \),
 * followed through symlinks and junctions when the folder exists on this
 * machine, put in Unicode NFC (macOS stores names decomposed), and case-folded
 * where the file system ignores case (Windows, and macOS by default). So
 * `E:\Packs\` and `e:/packs` are one folder on Windows.
 */
export function folderKey(path: string, platform: NodeJS.Platform = process.platform): string {
  let p = (platform === 'win32' ? win32 : posix).resolve(path.trim());
  if (platform === process.platform) {
    try {
      p = realpathSync.native(p);
    } catch {
      // Not there (unplugged drive, typo): compare the spelling alone.
    }
  }
  p = p.normalize('NFC');
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

/**
 * The scan location already at this folder, other than `exceptId`. Asset rows
 * are unique by path, so two locations on one folder take each pack from the
 * other on every scan, and removing either deletes the curation on all of
 * them. Only exact matches count: a folder inside another can be deliberate
 * (a Learn folder under a packs folder).
 */
export function findScanLocationAtPath(
  db: Database,
  path: string,
  exceptId?: number,
): ScanLocation | null {
  const key = folderKey(path);
  return (
    listScanLocations(db).find(
      (l) => l.id != null && l.id > 0 && l.id !== exceptId && folderKey(l.path) === key,
    ) ?? null
  );
}

export function createScanLocation(
  db: Database,
  loc: Omit<ScanLocation, 'id' | 'created_date'>,
): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO scan_locations (
      name, path, is_active, last_scan, scan_recursive, file_extensions, created_date,
      description, content_format, scan_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(
    loc.name,
    loc.path,
    toSqliteBool(loc.is_active),
    loc.last_scan,
    toSqliteBool(loc.scan_recursive),
    loc.file_extensions,
    now,
    loc.description,
    loc.content_format ?? null,
    loc.scan_mode ?? 'packs',
  );
  return Number(result.lastInsertRowid);
}

export function updateScanLocationActive(db: Database, id: number, isActive: boolean): void {
  db.prepare('UPDATE scan_locations SET is_active = ? WHERE id = ?').run(
    toSqliteBool(isActive),
    id,
  );
}

/** What removing a scan location takes with it (see `getScanLocationRemovalImpact`). */
export interface ScanLocationRemovalImpact {
  assets: number;
  favorites: number;
  /** Note rows that hold text or a rating; emptied rows don't count. */
  notes: number;
  taggedAssets: number;
  collectionEntries: number;
  /** Course lessons with a resume position or a completed mark. */
  lessonsWithProgress: number;
  /** Orbital matches the user dismissed. */
  matchDecisions: number;
}

/**
 * Count what `deleteScanLocation` will delete. `assets.scan_location_id` is
 * `ON DELETE CASCADE`, and notes, tags, collection entries, match decisions and
 * (through `course_files`) course progress cascade from `assets`, so the user's
 * curation goes with the folder. The confirm dialog
 * shows these numbers so the user can see that before agreeing.
 */
export function getScanLocationRemovalImpact(db: Database, id: number): ScanLocationRemovalImpact {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM assets WHERE scan_location_id = ?) AS assets,
         (SELECT COUNT(*) FROM assets WHERE scan_location_id = ? AND is_favorite = 1)
           AS favorites,
         (SELECT COUNT(*) FROM asset_notes n JOIN assets a ON a.id = n.asset_id
           WHERE a.scan_location_id = ?
             AND (TRIM(COALESCE(n.note_text, '')) <> '' OR n.rating IS NOT NULL)) AS notes,
         (SELECT COUNT(DISTINCT t.asset_id) FROM asset_tags t JOIN assets a ON a.id = t.asset_id
           WHERE a.scan_location_id = ?) AS taggedAssets,
         (SELECT COUNT(*) FROM collection_items c JOIN assets a ON a.id = c.asset_id
           WHERE a.scan_location_id = ?) AS collectionEntries,
         (SELECT COUNT(*) FROM course_progress p
            JOIN course_files f ON f.id = p.file_id
            JOIN assets a ON a.id = f.asset_id
           WHERE a.scan_location_id = ?
             AND (p.position_seconds > 0 OR p.completed = 1)) AS lessonsWithProgress,
         (SELECT COUNT(*) FROM orbital_match_rejections r JOIN assets a ON a.id = r.asset_id
           WHERE a.scan_location_id = ?) AS matchDecisions`,
    )
    .get(id, id, id, id, id, id, id) as ScanLocationRemovalImpact;
  return {
    assets: Number(row.assets),
    favorites: Number(row.favorites),
    notes: Number(row.notes),
    taggedAssets: Number(row.taggedAssets),
    collectionEntries: Number(row.collectionEntries),
    lessonsWithProgress: Number(row.lessonsWithProgress),
    matchDecisions: Number(row.matchDecisions),
  };
}

export function deleteScanLocation(db: Database, id: number): void {
  db.prepare('DELETE FROM scan_locations WHERE id = ?').run(id);
}

export interface ScanLocationUpdate {
  name?: string;
  path?: string;
  is_active?: boolean;
  scan_recursive?: boolean;
  file_extensions?: string | null;
  description?: string | null;
  content_format?: ContentFormat | null;
}

export function updateScanLocationFull(db: Database, id: number, update: ScanLocationUpdate): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (update.name !== undefined) {
    sets.push('name = ?');
    params.push(update.name);
  }
  if (update.path !== undefined) {
    sets.push('path = ?');
    params.push(update.path);
  }
  if (update.is_active !== undefined) {
    sets.push('is_active = ?');
    params.push(toSqliteBool(update.is_active));
  }
  if (update.scan_recursive !== undefined) {
    sets.push('scan_recursive = ?');
    params.push(toSqliteBool(update.scan_recursive));
  }
  if (update.file_extensions !== undefined) {
    sets.push('file_extensions = ?');
    params.push(update.file_extensions);
  }
  if (update.description !== undefined) {
    sets.push('description = ?');
    params.push(update.description);
  }
  if (update.content_format !== undefined) {
    sets.push('content_format = ?');
    params.push(update.content_format);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE scan_locations SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
}
