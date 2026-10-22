import type {
  ScanDiagnostic,
  ScanDiagnosticKind,
  ScanDiagnosticRow,
  ScanDiagnosticSummary,
} from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';

/**
 * Diagnostics are per-scan, not append-only: each scan replaces the rows it
 * owns for the kinds it produces. The walker persists its kinds when the
 * foreground pass commits; the background thumbnail job persists
 * `thumbnail-failed` separately once it finishes, which is why the caller
 * names the kinds it is replacing instead of clearing the location wholesale.
 */
export function replaceForLocation(
  db: Database,
  locationId: number,
  kinds: readonly ScanDiagnosticKind[],
  rows: readonly ScanDiagnostic[],
): void {
  const del = db.prepare('DELETE FROM scan_diagnostics WHERE scan_location_id = ? AND kind = ?');
  const ins = db.prepare(
    'INSERT INTO scan_diagnostics (scan_location_id, kind, path, detail) VALUES (?, ?, ?, ?)',
  );
  // Raw BEGIN/COMMIT (not `db.transaction()`) so this also runs under the
  // `node:sqlite` engine the repo tests use.
  db.exec('BEGIN');
  try {
    for (const kind of kinds) del.run(locationId, kind);
    for (const row of rows) ins.run(locationId, row.kind, row.path, row.detail);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Counts per kind across every location, biggest bucket first. */
export function summary(db: Database): ScanDiagnosticSummary[] {
  return db
    .prepare(
      'SELECT kind, COUNT(*) AS count FROM scan_diagnostics GROUP BY kind ORDER BY count DESC',
    )
    .all() as ScanDiagnosticSummary[];
}

/**
 * Drill-down for one kind. Capped — a library can produce tens of thousands
 * of rows for a single kind and the view only ever renders a page of them.
 */
export function listByKind(
  db: Database,
  kind: ScanDiagnosticKind,
  limit = 500,
): ScanDiagnosticRow[] {
  return db
    .prepare(
      `SELECT id, scan_location_id, kind, path, detail, created_at
         FROM scan_diagnostics
        WHERE kind = ?
        ORDER BY path
        LIMIT ?`,
    )
    .all(kind, limit) as ScanDiagnosticRow[];
}
