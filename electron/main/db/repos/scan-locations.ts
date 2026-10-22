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

export function createScanLocation(
  db: Database,
  loc: Omit<ScanLocation, 'id' | 'created_date'>,
): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO scan_locations (
      name, path, is_active, last_scan, scan_recursive, file_extensions, created_date,
      description, content_format
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
  return Number(result.lastInsertRowid);
}

export function updateScanLocationActive(db: Database, id: number, isActive: boolean): void {
  db.prepare('UPDATE scan_locations SET is_active = ? WHERE id = ?').run(
    toSqliteBool(isActive),
    id,
  );
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
