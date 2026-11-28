import { readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Pre-migration backups (`omnidex.db.bak-<ISO stamp>`, see `connection.ts`).
 *
 * Each app update that brings a migration writes a full copy of the catalog,
 * and nothing used to remove them. With transcripts indexed the catalog runs
 * to gigabytes, so a few updates could quietly fill a small disk. Once the
 * migrations have applied cleanly, only the newest `keep` backups stay.
 */
export const MIGRATION_BACKUP_KEEP = 2;

/** The `toISOString()` stamp with `:` and `.` swapped for `-`. */
const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;

/**
 * Backup file names for `dbFile`, newest first. Only names carrying the exact
 * stamp shape `connection.ts` writes: a copy the user made by hand
 * (`omnidex.db.bak-old`) is never counted or deleted.
 */
export function listMigrationBackups(dbFile: string): string[] {
  const prefix = `${basename(dbFile)}.bak-`;
  let names: string[];
  try {
    names = readdirSync(dirname(dbFile));
  } catch {
    return [];
  }
  // The stamp is an ISO time with `:`/`.` swapped for `-`, so it sorts
  // lexically in time order.
  return names
    .filter((n) => n.startsWith(prefix) && STAMP.test(n.slice(prefix.length)))
    .sort()
    .reverse();
}

/**
 * Delete all but the newest `keep` backups. Returns the paths it removed.
 * A file it can't delete (open elsewhere, permissions) is left alone: losing
 * a cleanup is fine, failing the boot over one is not.
 */
export function pruneMigrationBackups(
  dbFile: string,
  keep = MIGRATION_BACKUP_KEEP,
  /** Never deleted, even if a clock change sorts it oldest: the one just written. */
  protect?: string,
): string[] {
  const removed: string[] = [];
  const protectedName = protect ? basename(protect) : null;
  const names = listMigrationBackups(dbFile).filter((n) => n !== protectedName);
  const slots = Math.max(0, keep - (protectedName ? 1 : 0));
  for (const name of names.slice(slots)) {
    const full = join(dirname(dbFile), name);
    try {
      rmSync(full, { force: true });
      removed.push(full);
    } catch {
      // Leave it.
    }
  }
  return removed;
}
