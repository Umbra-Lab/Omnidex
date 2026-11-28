import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedAsset } from '../../db/repos/__tests__/fixtures/test-db';
import { sweepOrphanThumbnails } from '../thumbnail-sweep';

const DAY = 24 * 60 * 60 * 1000;

describe('sweepOrphanThumbnails', () => {
  let db: Database;
  let dir: string;
  const now = Date.now();

  /** Write a file and backdate it, so the age guard sees it as `ageMs` old. */
  function file(rel: string, ageMs = 2 * DAY, bytes = 10): string {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, Buffer.alloc(bytes));
    const t = (now - ageMs) / 1000;
    utimesSync(full, t, t);
    return full;
  }

  beforeEach(() => {
    db = createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'omnidex-sweep-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes old thumbnails no asset points at, and keeps the ones in use', async () => {
    const used = file('aaa.png');
    const usedUnity = file('unity/bbb.png');
    const orphan = file('ccc.png', 2 * DAY, 100);
    const orphanUnity = file('unity/ddd.png', 2 * DAY, 50);
    seedAsset(db, { name: 'A', file_path: '/lib/A', thumbnail_path: used });
    seedAsset(db, { name: 'B', file_path: '/lib/B', thumbnail_path: usedUnity });

    const result = await sweepOrphanThumbnails(db, dir, { now });

    expect(result).toEqual({ removed: 2, freedBytes: 150 });
    expect(existsSync(used)).toBe(true);
    expect(existsSync(usedUnity)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(orphanUnity)).toBe(false);
  });

  it('keeps a file an extraction may have just written', async () => {
    // The pool writes the PNG before the row; a young file may be mid-flight.
    const fresh = file('fresh.png', 60 * 1000);
    const result = await sweepOrphanThumbnails(db, dir, { now });
    expect(result.removed).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it('matches by file name, so a differently spelled folder still counts as in use', async () => {
    // Rows that still point at the legacy Electron folder, or at a userData
    // folder whose case changed, name the same file in another place.
    const legacy = file('ABC123.png');
    const cased = file('def456.png');
    seedAsset(db, {
      name: 'Legacy',
      file_path: '/lib/L',
      thumbnail_path: 'C:\\Users\\me\\AppData\\Roaming\\Electron\\thumbnails\\ABC123.png',
    });
    seedAsset(db, {
      name: 'Cased',
      file_path: '/lib/C',
      thumbnail_path: 'C:\\Users\\me\\AppData\\Roaming\\Omnidex\\thumbnails\\DEF456.PNG',
    });

    const result = await sweepOrphanThumbnails(db, dir, { now });

    expect(result.removed).toBe(0);
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(cased)).toBe(true);
  });

  it('keeps the thumbnail of a pack that is missing from disk but still in the library', async () => {
    // A soft-deleted row keeps its curation and comes back on a rename; its
    // thumbnail must come back with it.
    const kept = file('missing.png');
    const id = seedAsset(db, { name: 'Gone', file_path: '/lib/Gone', thumbnail_path: kept });
    db.prepare("UPDATE assets SET missing_since = '2026-11-01T00:00:00Z' WHERE id = ?").run(id);

    await sweepOrphanThumbnails(db, dir, { now });

    expect(existsSync(kept)).toBe(true);
  });

  it('leaves files that are not images, and folders deeper than the Unity one', async () => {
    const notes = file('readme.txt');
    const deep = file('unity/nested/eee.png');
    const result = await sweepOrphanThumbnails(db, dir, { now });
    expect(result.removed).toBe(0);
    expect(existsSync(notes)).toBe(true);
    expect(existsSync(deep)).toBe(true);
  });

  it('does nothing when the folder does not exist yet', async () => {
    const result = await sweepOrphanThumbnails(db, join(dir, 'never-made'), { now });
    expect(result).toEqual({ removed: 0, freedBytes: 0 });
  });
});
