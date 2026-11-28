import { readdir, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Database } from 'better-sqlite3';

/** Only files the extractors write. Anything else in the folder is left alone. */
const SWEEPABLE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * A file this young may belong to an extraction that has written its PNG but
 * not yet its `thumbnail_path` row (the pool writes the file first, the DB
 * second, and Unity scans do the same). A day is far longer than any
 * extraction, so the sweep never needs to know which jobs are running.
 */
export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface SweepResult {
  removed: number;
  freedBytes: number;
}

/**
 * Delete extracted thumbnails that no asset points at any more.
 *
 * Thumbnail files are named by a hash of their source, so a pack that is
 * renamed, moved, pruned from a scan or dropped with its scan folder leaves
 * its PNG behind for good. Nothing else ever deletes them, so on a library
 * that churns the cache only grows.
 *
 * A file is kept when any `assets.thumbnail_path` has the same file name,
 * compared without case. Matching on the name alone, not the full path, keeps
 * the sweep safe where the stored path and `thumbnailsDir()` are spelled
 * differently: a userData folder whose case changed, or rows still pointing at
 * the legacy `Electron\thumbnails` folder that the thumbs repair rewrites. The
 * names are content hashes, so a false "still used" costs at most one file.
 */
export async function sweepOrphanThumbnails(
  db: Database,
  dir: string,
  opts: { minAgeMs?: number; now?: number } = {},
): Promise<SweepResult> {
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const now = opts.now ?? Date.now();

  const referenced = new Set<string>();
  const rows = db
    .prepare(
      "SELECT thumbnail_path FROM assets WHERE thumbnail_path IS NOT NULL AND thumbnail_path <> ''",
    )
    .all() as { thumbnail_path: string }[];
  for (const { thumbnail_path } of rows) {
    // Stored paths can be Windows paths even when read elsewhere (tests, a
    // copied DB), so split on both separators rather than trust `basename`.
    const name = thumbnail_path.split(/[\\/]/).pop();
    if (name) referenced.add(name.toLowerCase());
  }

  const result: SweepResult = { removed: 0, freedBytes: 0 };
  await sweepDir(dir, 0);
  return result;

  async function sweepDir(current: string, depth: number): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // Missing folder (nothing extracted yet) or unreadable.
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        // The pool writes to the root, Unity to `unity/`. One level covers both.
        if (depth < 1) await sweepDir(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SWEEPABLE_EXT.has(extname(entry.name).toLowerCase())) continue;
      if (referenced.has(basename(entry.name).toLowerCase())) continue;
      try {
        const info = await stat(full);
        if (now - info.mtimeMs < minAgeMs) continue;
        await unlink(full);
        result.removed += 1;
        result.freedBytes += info.size;
      } catch {
        // Raced with a purge, or locked by a viewer on Windows: skip it, the
        // next launch tries again.
      }
    }
  }
}
