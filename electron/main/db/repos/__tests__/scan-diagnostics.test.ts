import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listByKind, replaceForLocation, summary } from '../scan-diagnostics';

/**
 * The replace semantics are the non-obvious part: the walk and the background
 * thumbnail job finish at different times and each owns different kinds, so a
 * write from one must never clear the other's rows.
 *
 * Schema is read from the real migration rather than retyped, minus the FK to
 * `scan_locations` (not created here) — a divergence would silently pass.
 */
const MIGRATION = join(
  import.meta.dirname,
  '../../migrations/20260728000000_create_scan_diagnostics.up.sql',
);

let db: Database;

beforeEach(() => {
  const sql = readFileSync(MIGRATION, 'utf8').replace(
    /,\s*\n\s*FOREIGN KEY \(scan_location_id\)[^\n]*\n/,
    '\n',
  );
  db = new DatabaseSync(':memory:') as unknown as Database;
  db.exec(sql);
});
afterEach(() => {
  (db as unknown as DatabaseSync).close();
});

describe('scan diagnostics repo', () => {
  it('replaces only the kinds it is given', () => {
    replaceForLocation(
      db,
      1,
      ['archive-only', 'depth-limit-abandoned'],
      [
        { kind: 'archive-only', path: 'E:\\Sealed', detail: '2 archives' },
        { kind: 'depth-limit-abandoned', path: 'E:\\Deep', detail: 'too deep' },
      ],
    );
    replaceForLocation(
      db,
      1,
      ['thumbnail-failed'],
      [{ kind: 'thumbnail-failed', path: 'E:\\Pack', detail: 'no image' }],
    );

    // The thumbnail write must not have touched the walk's rows.
    expect(Object.fromEntries(summary(db).map((r) => [r.kind, r.count]))).toEqual({
      'archive-only': 1,
      'depth-limit-abandoned': 1,
      'thumbnail-failed': 1,
    });

    // A second walk supersedes the first walk's rows, not the thumbnail row.
    replaceForLocation(
      db,
      1,
      ['archive-only', 'depth-limit-abandoned'],
      [{ kind: 'archive-only', path: 'E:\\Sealed', detail: '2 archives' }],
    );
    expect(Object.fromEntries(summary(db).map((r) => [r.kind, r.count]))).toEqual({
      'archive-only': 1,
      'thumbnail-failed': 1,
    });
  });

  it('scopes replacement to one location', () => {
    const row = { kind: 'archive-only' as const, path: 'E:\\A', detail: 'x' };
    replaceForLocation(db, 1, ['archive-only'], [row]);
    replaceForLocation(db, 2, ['archive-only'], [{ ...row, path: 'F:\\B' }]);
    replaceForLocation(db, 1, ['archive-only'], []);

    const remaining = listByKind(db, 'archive-only');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.scan_location_id).toBe(2);
  });

  it('caps the drill-down list', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      kind: 'thumbnail-failed' as const,
      path: `E:\\Pack${String(i).padStart(2, '0')}`,
      detail: 'no image',
    }));
    replaceForLocation(db, 1, ['thumbnail-failed'], many);

    expect(listByKind(db, 'thumbnail-failed', 5)).toHaveLength(5);
    expect(summary(db)[0]?.count).toBe(12);
  });
});
