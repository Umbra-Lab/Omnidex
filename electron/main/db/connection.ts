import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { runMigrations } from './migrator';
import { dbPath } from './paths';

let instance: BetterSqliteDatabase | null = null;

/**
 * Thrown when `PRAGMA quick_check` reports the on-disk database is corrupt.
 * The boot guard in `index.ts` catches this to warn the user rather than
 * letting the app run against a damaged catalog.
 */
export class DatabaseIntegrityError extends Error {
  readonly dbFilePath: string;
  readonly details: string;

  constructor(dbFilePath: string, details: string) {
    super(`Database integrity check failed for ${dbFilePath}: ${details}`);
    this.name = 'DatabaseIntegrityError';
    this.dbFilePath = dbFilePath;
    this.details = details;
  }
}

/**
 * Runs `PRAGMA quick_check` and throws `DatabaseIntegrityError` if SQLite
 * reports anything other than a single `ok`. `quick_check` is the cheaper
 * cousin of `integrity_check` — it skips the (slow) verification that index
 * contents match their tables but still catches structural page corruption,
 * which is the failure mode that would otherwise crash queries downstream.
 */
function assertIntegrity(db: BetterSqliteDatabase, path: string): void {
  const rows = db.pragma('quick_check') as Array<{ quick_check: string }>;
  const messages = rows.map((r) => r.quick_check);
  if (messages.length !== 1 || messages[0] !== 'ok') {
    throw new DatabaseIntegrityError(path, messages.join('; '));
  }
}

/**
 * Snapshots the database to a timestamped sibling file via `VACUUM INTO`.
 * Returns the backup path. `VACUUM INTO` writes a single, consistent file that
 * already folds in committed WAL data, so it is safe even in WAL mode where a
 * raw file copy would miss the `-wal` sidecar.
 *
 * Used as `runMigrations`' `onBeforeApply` hook so the user's only catalog copy
 * is preserved before a (potentially failing) migration mutates it.
 */
function backupBeforeMigrate(db: BetterSqliteDatabase, path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.bak-${stamp}`;
  // Single-quote escaping for the SQL string literal.
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}

/**
 * Opens (or returns) the singleton SQLite connection.
 *
 * PRAGMAs mirror the Tauri/SQLx setup in
 * `src-tauri/src/database/database_manager.rs::new`:
 *   journal_mode=WAL, synchronous=NORMAL, cache_size=-64000 (64 MiB),
 *   temp_store=MEMORY, busy_timeout=5000, foreign_keys=ON.
 *
 * On open the file is integrity-checked (`PRAGMA quick_check`) and, if any
 * migrations are pending, backed up before they apply. A corrupt file surfaces
 * as `DatabaseIntegrityError`; a failed migration as `MigrationError` — both
 * propagate to the boot guard rather than leaving the app on a bad catalog.
 */
export function openDatabase(): BetterSqliteDatabase {
  if (instance) return instance;

  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('temp_store = MEMORY');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  try {
    assertIntegrity(db, path);
    // Propagates MigrationError (with the backup path) if a migration throws.
    runMigrations(db, { onBeforeApply: () => backupBeforeMigrate(db, path) });
  } catch (err) {
    // Don't leak the half-open handle if boot fails; the caller decides what
    // to do (e.g. show a recovery dialog) from the typed error.
    db.close();
    throw err;
  }

  instance = db;
  return db;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
