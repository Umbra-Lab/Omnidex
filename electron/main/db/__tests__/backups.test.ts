import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listMigrationBackups, pruneMigrationBackups } from '../backups';

describe('pre-migration backup pruning', () => {
  let dir: string;
  let db: string;
  const stamps = [
    '2026-01-05T10-00-00-000Z',
    '2026-11-28T09-30-00-000Z',
    '2026-06-14T00-00-00-000Z',
    '2025-12-31T23-59-59-999Z',
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnidex-bak-'));
    db = join(dir, 'omnidex.db');
    for (const f of ['omnidex.db', 'omnidex.db-wal', 'other.db.bak-2020-01-01T00-00-00-000Z']) {
      writeFileSync(join(dir, f), '');
    }
    for (const s of stamps) writeFileSync(`${db}.bak-${s}`, '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists only this database’s backups, newest first', () => {
    expect(listMigrationBackups(db)).toEqual([
      'omnidex.db.bak-2026-11-28T09-30-00-000Z',
      'omnidex.db.bak-2026-06-14T00-00-00-000Z',
      'omnidex.db.bak-2026-01-05T10-00-00-000Z',
      'omnidex.db.bak-2025-12-31T23-59-59-999Z',
    ]);
  });

  it('keeps the newest two and nothing else of theirs', () => {
    const removed = pruneMigrationBackups(db);
    expect(removed.map((p) => p.slice(dir.length + 1)).sort()).toEqual([
      'omnidex.db.bak-2025-12-31T23-59-59-999Z',
      'omnidex.db.bak-2026-01-05T10-00-00-000Z',
    ]);
    expect(listMigrationBackups(db)).toHaveLength(2);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(`${db}-wal`)).toBe(true);
    expect(existsSync(join(dir, 'other.db.bak-2020-01-01T00-00-00-000Z'))).toBe(true);
  });

  it('is a no-op with fewer backups than it keeps, or no folder at all', () => {
    expect(pruneMigrationBackups(db, 10)).toEqual([]);
    expect(pruneMigrationBackups(join(dir, 'missing', 'omnidex.db'))).toEqual([]);
  });
});
