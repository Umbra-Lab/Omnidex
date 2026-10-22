import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationError, runMigrations } from '../migrator';

/**
 * The shipping `better-sqlite3` binary is built against Electron's ABI and won't
 * load under the Node that runs Vitest, so we drive the real `runMigrations`
 * code against Node's built-in `node:sqlite` engine — the same trick the repo
 * fixtures use. The migrator only touches `.exec` / `.prepare().all|run`, all of
 * which both engines share, and it now wraps each migration in an explicit
 * BEGIN/COMMIT/ROLLBACK instead of better-sqlite3's `db.transaction()`.
 */
function createMemDb(): Database {
  return new DatabaseSync(':memory:') as unknown as Database;
}

let db: Database;
let dir: string;

beforeEach(() => {
  db = createMemDb();
  dir = mkdtempSync(join(tmpdir(), 'omnidex-migrator-'));
});

afterEach(() => {
  (db as unknown as { close: () => void }).close();
  rmSync(dir, { recursive: true, force: true });
});

/** Drop a `<name>.up.sql` file into the tmp migrations dir. */
function writeMigration(name: string, sql: string): void {
  writeFileSync(join(dir, `${name}.up.sql`), sql, 'utf8');
}

function appliedIds(database: Database): string[] {
  return (database.prepare('SELECT id FROM _omnidex_migrations ORDER BY id').all() as {
    id: string;
  }[]).map((r) => r.id);
}

describe('runMigrations — clean apply', () => {
  it('applies every pending migration once, in filename order', () => {
    writeMigration('001_a', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeMigration('002_b', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');

    expect(() => runMigrations(db, { migrationsDir: dir })).not.toThrow();

    // Both tables exist and both ids are recorded.
    expect(appliedIds(db)).toEqual(['001_a', '002_b']);
    expect(() => db.exec('INSERT INTO a (id) VALUES (1)')).not.toThrow();
    expect(() => db.exec('INSERT INTO b (id) VALUES (1)')).not.toThrow();
  });

  it('is idempotent — a second run skips already-applied migrations', () => {
    writeMigration('001_a', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    runMigrations(db, { migrationsDir: dir });

    // Re-running must not re-execute the CREATE (which would throw "table exists").
    expect(() => runMigrations(db, { migrationsDir: dir })).not.toThrow();
    expect(appliedIds(db)).toEqual(['001_a']);
  });

  it('calls onBeforeApply exactly once when there are pending migrations', () => {
    writeMigration('001_a', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeMigration('002_b', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    const onBeforeApply = vi.fn(() => '/tmp/omnidex.db.bak-stamp');

    runMigrations(db, { migrationsDir: dir, onBeforeApply });

    expect(onBeforeApply).toHaveBeenCalledTimes(1);
  });

  it('skips the backup (onBeforeApply) when nothing is pending', () => {
    writeMigration('001_a', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    runMigrations(db, { migrationsDir: dir });

    const onBeforeApply = vi.fn(() => '/tmp/should-not-be-written');
    runMigrations(db, { migrationsDir: dir, onBeforeApply });

    expect(onBeforeApply).not.toHaveBeenCalled();
  });
});

describe('runMigrations — failure', () => {
  it('wraps a broken migration in a MigrationError carrying its filename', () => {
    writeMigration('001_ok', 'CREATE TABLE ok (id INTEGER PRIMARY KEY);');
    writeMigration('002_broken', 'THIS IS NOT VALID SQL;');

    let caught: unknown;
    try {
      runMigrations(db, { migrationsDir: dir });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MigrationError);
    const error = caught as MigrationError;
    // migrationName is the failing `.up.sql` file.
    expect(error.migrationName).toBe('002_broken.up.sql');
    // The earlier, valid migration committed; the broken one did not.
    expect(appliedIds(db)).toEqual(['001_ok']);
  });

  it('attaches the backup path returned by onBeforeApply to the error', () => {
    writeMigration('001_broken', 'NONSENSE SQL HERE;');
    const backupPath = '/var/data/omnidex.db.bak-2026-06-14T00-00-00-000Z';

    let caught: unknown;
    try {
      runMigrations(db, { migrationsDir: dir, onBeforeApply: () => backupPath });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).backupPath).toBe(backupPath);
  });

  it('rolls the failing migration back so no partial schema leaks', () => {
    // First statement succeeds, second is invalid — the whole file must roll back.
    writeMigration(
      '001_partial',
      'CREATE TABLE partial (id INTEGER PRIMARY KEY); BROKEN STATEMENT;',
    );

    expect(() => runMigrations(db, { migrationsDir: dir })).toThrow(MigrationError);

    // The table from the first statement must NOT survive the rollback.
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual([]);
    expect(appliedIds(db)).toEqual([]);
  });

  it('exposes MigrationError as a real Error subclass with name and message', () => {
    writeMigration('001_broken', 'BORKED;');
    try {
      runMigrations(db, { migrationsDir: dir });
      throw new Error('expected runMigrations to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).name).toBe('MigrationError');
      expect((err as MigrationError).message).toContain('001_broken.up.sql');
    }
  });
});
