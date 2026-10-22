import { type Dirent, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shell } from 'electron';
import { z } from 'zod';
import { openDatabase } from '../../db';
import { dbPath, thumbnailsDir, userDataDir } from '../../db/paths';
import { appSettingsRepo } from '../../db/repos';
import { getLogFilePath } from '../../logger';
import { publicProcedure, router } from '../init';

const upsertSchema = z.object({
  key: z.string(),
  value: z.string(),
  setting_type: z.string(),
  description: z.string().nullable().optional(),
});

/** Recursive byte + file count for a directory that may not exist yet. */
function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0 };
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(full);
      bytes += sub.bytes;
      files += sub.files;
      continue;
    }
    try {
      bytes += statSync(full).size;
      files += 1;
    } catch {
      // Raced with a delete — skip rather than fail the whole measurement.
    }
  }
  return { bytes, files };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export const settingsRouter = router({
  list: publicProcedure.query(() => appSettingsRepo.listSettings(openDatabase())),

  /**
   * On-disk footprint of everything Omnidex owns. Answers "what is this app
   * costing me and where does it live" without the user hunting for a
   * platform-specific app-data path.
   */
  storage: publicProcedure.query(() => {
    const db = dbPath();
    const thumbs = thumbnailsDir();
    const thumbStats = dirSize(thumbs);
    const logFile = getLogFilePath();
    const logDir = logFile ? dirname(logFile) : null;
    return {
      dbPath: db,
      // WAL + shm are part of the footprint; reporting only the .db file
      // understates it by however much is still uncheckpointed.
      dbBytes: fileSize(db) + fileSize(`${db}-wal`) + fileSize(`${db}-shm`),
      thumbnailsPath: thumbs,
      thumbnailBytes: thumbStats.bytes,
      thumbnailCount: thumbStats.files,
      logPath: logDir,
      logBytes: logDir ? dirSize(logDir).bytes : 0,
      userDataPath: userDataDir(),
    };
  }),

  /**
   * Drop the extracted-thumbnail cache. The rows that pointed into it are
   * cleared in the same call — deleting the PNGs alone would leave every card
   * referencing a missing file, whereas nulling `thumbnail_path` puts those
   * packs back in the extractor's queue for the next scan.
   */
  purgeThumbnails: publicProcedure.mutation(() => {
    const dir = thumbnailsDir();
    const before = dirSize(dir);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    openDatabase()
      .prepare(
        'UPDATE assets SET thumbnail_path = NULL, has_local_thumbnail = 0 WHERE thumbnail_path IS NOT NULL',
      )
      .run();
    return { removed: before.files, freedBytes: before.bytes };
  }),

  /**
   * Reveal the active log file. Selecting the file (rather than opening the
   * folder) answers "which of these five rotations is current" for the user.
   */
  openLogFolder: publicProcedure.mutation(async () => {
    const logFile = getLogFilePath();
    if (!logFile) return { ok: false, error: 'Logging is not initialized' };
    if (existsSync(logFile)) {
      shell.showItemInFolder(logFile);
      return { ok: true, error: null };
    }
    const err = await shell.openPath(dirname(logFile));
    return err ? { ok: false, error: err } : { ok: true, error: null };
  }),

  get: publicProcedure
    .input(z.string())
    .query(({ input }) => appSettingsRepo.getSetting(openDatabase(), input)),

  set: publicProcedure.input(upsertSchema).mutation(({ input }) => {
    appSettingsRepo.setSetting(
      openDatabase(),
      input.key,
      input.value,
      input.setting_type,
      input.description ?? null,
    );
    return true;
  }),

  delete: publicProcedure.input(z.string()).mutation(({ input }) => {
    appSettingsRepo.deleteSetting(openDatabase(), input);
    return true;
  }),
});
