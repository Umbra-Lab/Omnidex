import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedAsset } from '../../db/repos/__tests__/fixtures/test-db';
import { BACKGROUND_THUMBNAIL_SQL } from '../thumbnail-sql';

/**
 * The background thumbnail job is queued during the upsert pass but runs after
 * `indexCourseManifests`, which may have set a course cover in the meantime.
 * Bound to the real statement so the guard cannot drift away from it.
 */

let db: Database;

beforeEach(() => {
  db = createTestDb();
  // Production column (normalize_asset_schema migration) the shared fixture omits.
  db.exec('ALTER TABLE assets ADD COLUMN has_local_thumbnail BOOLEAN NOT NULL DEFAULT 0');
});
afterEach(() => {
  (db as unknown as { close: () => void }).close();
});

const thumbOf = (path: string) =>
  db
    .prepare('SELECT thumbnail_path, has_local_thumbnail FROM assets WHERE file_path = ?')
    .get(path);

describe('background thumbnail write', () => {
  it('fills a pack that has no thumbnail', () => {
    seedAsset(db, { name: 'Pack', file_path: '/lib/Pack' });
    db.prepare('UPDATE assets SET thumbnail_path = NULL WHERE file_path = ?').run('/lib/Pack');
    db.prepare(BACKGROUND_THUMBNAIL_SQL).run('/thumbs/pack.png', '/lib/Pack');
    expect(thumbOf('/lib/Pack')).toEqual({
      thumbnail_path: '/thumbs/pack.png',
      has_local_thumbnail: 1,
    });
  });

  it('does not overwrite a course cover set after the job was queued', () => {
    seedAsset(db, { name: 'Course', file_path: '/c/Course', content_format: 'course' });
    // What indexCourseManifests writes: the largest image in the course.
    db.prepare(
      'UPDATE assets SET thumbnail_path = ?, has_local_thumbnail = 1 WHERE file_path = ?',
    ).run('/c/Course/cover.jpg', '/c/Course');
    db.prepare(BACKGROUND_THUMBNAIL_SQL).run('/c/Course/Project/icon.png', '/c/Course');
    expect(thumbOf('/c/Course')).toEqual({
      thumbnail_path: '/c/Course/cover.jpg',
      has_local_thumbnail: 1,
    });
  });
});
