import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createScanLocation,
  getScanLocation,
  listScanLocations,
  updateScanLocationFull,
} from '../scan-locations';

/**
 * `content_format` on a location is what routes its assets to the Learn tab
 * instead of the pack library, so the round-trip has to be exact: a course
 * location must come back as `'course'`, and — the case that matters for every
 * pre-existing location — an asset location must come back as `null`, never
 * `undefined` or `''`, because the Learn queries key on `IS NOT NULL`.
 *
 * The `scan_locations` schema is built from the base table plus the real
 * migration that adds the column, rather than retyped, so a divergence between
 * this fixture and shipped SQL cannot pass silently.
 */
const CONTENT_FORMAT_MIGRATION = join(
  import.meta.dirname,
  '../../migrations/20260730000000_add_scan_location_content_format.up.sql',
);

const BASE_SCHEMA = /* sql */ `
CREATE TABLE scan_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT 1,
  last_scan TEXT,
  scan_recursive BOOLEAN NOT NULL DEFAULT 0,
  file_extensions TEXT,
  created_date TEXT NOT NULL,
  description TEXT
);
`;

let db: Database;

beforeEach(() => {
  db = new DatabaseSync(':memory:') as unknown as Database;
  db.exec(BASE_SCHEMA);
  db.exec(readFileSync(CONTENT_FORMAT_MIGRATION, 'utf8'));
});
afterEach(() => {
  (db as unknown as DatabaseSync).close();
});

function seed(overrides: Partial<Parameters<typeof createScanLocation>[1]> = {}) {
  return createScanLocation(db, {
    name: 'Library',
    path: `E:/lib/${Math.random().toString(36).slice(2)}`,
    is_active: true,
    last_scan: null,
    scan_recursive: true,
    file_extensions: null,
    description: null,
    content_format: null,
    ...overrides,
  });
}

describe('scan locations repo — content_format', () => {
  it('round-trips a course location', () => {
    const id = seed({ name: 'Courses', content_format: 'course' });
    expect(getScanLocation(db, id)?.content_format).toBe('course');
  });

  it('stores null for an asset location', () => {
    const id = seed();
    expect(getScanLocation(db, id)?.content_format).toBeNull();
  });

  it('defaults to null when the caller omits the column entirely', () => {
    // The migration adds a nullable column with no default, so a location
    // written by code that predates it must read back as a regular asset
    // location rather than as an empty string.
    db.prepare(
      `INSERT INTO scan_locations (name, path, is_active, scan_recursive, created_date)
       VALUES ('Legacy', 'E:/legacy', 1, 1, '2026-01-01T00:00:00Z')`,
    ).run();
    const legacy = listScanLocations(db).find((l) => l.name === 'Legacy');
    expect(legacy?.content_format).toBeNull();
  });

  it('updates the format without touching other fields', () => {
    const id = seed({ name: 'Courses', description: 'keep me' });
    updateScanLocationFull(db, id, { content_format: 'workshop' });
    const after = getScanLocation(db, id);
    expect(after?.content_format).toBe('workshop');
    expect(after?.description).toBe('keep me');
    expect(after?.name).toBe('Courses');
  });

  it('clears the format back to null', () => {
    const id = seed({ content_format: 'ebook' });
    updateScanLocationFull(db, id, { content_format: null });
    expect(getScanLocation(db, id)?.content_format).toBeNull();
  });

  it('leaves the format alone when the update omits it', () => {
    // `undefined` means "not provided" in ScanLocationUpdate — distinct from an
    // explicit null, which clears. Conflating the two would silently drop a
    // location out of the Learn tab on an unrelated rename.
    const id = seed({ content_format: 'course' });
    updateScanLocationFull(db, id, { name: 'Renamed' });
    const after = getScanLocation(db, id);
    expect(after?.name).toBe('Renamed');
    expect(after?.content_format).toBe('course');
  });
});
