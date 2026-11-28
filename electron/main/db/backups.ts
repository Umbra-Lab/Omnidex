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

/** Backup file names for `dbFile`, newest first. */
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
    .filter((n) => n.startsWith(prefix) && n.length > prefix.length)
    .sort()
    .reverse();
}

/**
 * Delete all but the newest `keep` backups. Returns the paths it removed.
 * A file it can't delete (open elsewhere, permissions) is left alone: losing
 * a cleanup is fine, failing the boot over one is not.
 */
export function pruneMigrationBackups(dbFile: string, keep = MIGRATION_BACKUP_KEEP): string[] {
  const removed: string[] = [];
  for (const name of listMigrationBackups(dbFile).slice(Math.max(0, keep))) {
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
