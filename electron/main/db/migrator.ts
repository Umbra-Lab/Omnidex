import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

/**
 * Resolves the directory containing the `.up.sql` files, bundled next to this
 * module at build time. electron-vite copies `electron/main/db/migrations/`
 * verbatim into `out/main/migrations/`.
 *
 * Resolved lazily (not at module load) because `import.meta.url` is not a
 * `file:` URL under the Vitest transform — tests pass an explicit
 * `migrationsDir` and never hit this path.
 *
 * Source of truth during migration is `src-tauri/migrations/` — the
 * `sync-migrations` tooling (Phase 1 follow-up) keeps this directory in sync.
 * After Phase 4, `electron/main/db/migrations/` becomes the sole source.
 */
function defaultMigrationsDir(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), 'migrations');
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _omnidex_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`;

/**
 * Thrown when a `.up.sql` migration fails to apply. The boot guard in
 * `index.ts` catches this exact shape to show a recovery dialog: it tells the
 * user which migration broke and where the pre-migration backup landed so the
 * catalog can be restored.
 *
 * `backupPath` is the timestamped copy taken *before* any pending migration ran
 * (see `runMigrations`). It is `undefined` only when no backup could be written
 * (e.g. an in-memory database, or the backup step itself failed).
 */
export class MigrationError extends Error {
  readonly migrationName: string;
  readonly backupPath?: string;

  constructor(migrationName: string, cause: unknown, backupPath?: string) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Migration "${migrationName}" failed: ${message}`);
    this.name = 'MigrationError';
    this.migrationName = migrationName;
    this.backupPath = backupPath;
    // Preserve the original error for diagnostics without losing our typed shape.
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface RunMigrationsOptions {
  /**
   * Directory to read `*.up.sql` files from. Defaults to the bundled
   * migrations dir (see `defaultMigrationsDir`). Overridable so tests can point
   * at a fixture dir.
   */
  migrationsDir?: string;
  /**
   * Invoked exactly once, immediately before the first pending migration is
   * applied (and never when there is nothing to migrate). Returns the path to
   * the backup it wrote, which is attached to any `MigrationError` so the boot
   * guard can offer a restore. Errors thrown here propagate as-is — a failed
   * backup must abort the upgrade rather than risk the user's only catalog.
   */
  onBeforeApply?: () => string | undefined;
}

/**
 * Applies every `*.up.sql` file in the migrations dir in filename-sorted order
 * exactly once. Idempotent — already-applied migrations are skipped.
 *
 * Before the first pending migration runs, `onBeforeApply` is called so the
 * caller can snapshot the database (see `connection.ts`). If a migration
 * throws, it is wrapped in a `MigrationError` carrying the failed migration's
 * name and the backup path, then rethrown.
 *
 * Uses a distinct tracking table (`_omnidex_migrations`) so the Electron
 * runtime does not collide with SQLx's `_sqlx_migrations` table during
 * co-existence. A future one-shot tool can reconcile state if needed.
 *
 * Each migration is wrapped in an explicit `BEGIN`/`COMMIT`/`ROLLBACK` rather
 * than better-sqlite3's `db.transaction()` so the same code path runs under
 * Node's built-in `node:sqlite` engine in tests.
 */
export function runMigrations(db: Database, options: RunMigrationsOptions = {}): void {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();

  db.exec(CREATE_TABLE_SQL);

  const appliedStmt = db.prepare('SELECT id FROM _omnidex_migrations');
  const applied = new Set<string>((appliedStmt.all() as { id: string }[]).map((row) => row.id));

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.up.sql'))
    .sort();

  const pending = files.filter((file) => !applied.has(file.replace(/\.up\.sql$/, '')));
  if (pending.length === 0) return;

  // Snapshot the catalog before mutating it. If this throws, we abort before
  // touching the database — a failed backup must not let a risky migration run.
  const backupPath = options.onBeforeApply?.();

  const insertStmt = db.prepare('INSERT INTO _omnidex_migrations (id) VALUES (?)');

  for (const file of pending) {
    const id = file.replace(/\.up\.sql$/, '');
    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    db.exec('BEGIN');
    try {
      db.exec(sql);
      insertStmt.run(id);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Rollback can fail if the transaction was already aborted; ignore so
        // the original migration error is the one that surfaces.
      }
      console.error(`[migrator] FAILED at ${id}:`, (err as Error).message);
      throw new MigrationError(file, err, backupPath);
    }
  }
}
