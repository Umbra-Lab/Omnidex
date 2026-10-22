import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Regression coverage for the `get_scraper_metrics` legacy command.
 *
 * The original query SELECTed `AVG(duration_ms)` and `SUM(success = 1)`, but
 * the real `scraper_metrics` table is an event log with no such columns
 * (id, timestamp, metric_type, value, metadata, session_id). better-sqlite3
 * therefore threw "no such column: duration_ms" every time the handler ran.
 *
 * This test pins the corrected queries to the *real* schema: it extracts the
 * actual `CREATE TABLE scraper_metrics` statement from the migration that ships
 * it, applies it to an in-memory SQLite, and runs the exact SQL the command now
 * uses. If anyone reshapes the table such that these columns vanish again, the
 * prepare() calls here will throw and this test fails — the same failure the
 * production handler would hit.
 *
 * This guards the `scraper_metrics` table contract: the columns these queries
 * read (`timestamp`, `metric_type`) must survive future migrations. The SQL is
 * inlined rather than imported because the queries' original home imported
 * `electron` and the native `better-sqlite3` binding (compiled for Electron's
 * ABI, unloadable under Vitest's Node) — so this test mirrors the shapes
 * directly and validates them against the real migration.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(
  __dirname,
  '../../db/migrations/20251011101430_create_orbital_cache.up.sql',
);

// Queries against the scraper_metrics table; kept in sync with the migration.
const TOTAL_SQL = `SELECT COUNT(*) AS total,
          MAX(timestamp) AS last_recorded
   FROM scraper_metrics`;
const BY_TYPE_SQL = `SELECT metric_type, COUNT(*) AS count
   FROM scraper_metrics
   GROUP BY metric_type`;

/** Pull the real `CREATE TABLE scraper_metrics (...)` out of the migration. */
function realScraperMetricsSchema(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const match = sql.match(/CREATE TABLE IF NOT EXISTS scraper_metrics\s*\([\s\S]*?\);/i);
  if (!match) throw new Error('scraper_metrics CREATE TABLE not found in migration');
  return match[0];
}

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(realScraperMetricsSchema());
});

afterEach(() => {
  db.close();
});

describe('get_scraper_metrics query against the real scraper_metrics schema', () => {
  it('the real migration table has no duration_ms / success columns (the original bug)', () => {
    const cols = (db.prepare('PRAGMA table_info(scraper_metrics)').all() as Array<{
      name: string;
    }>).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'timestamp', 'metric_type', 'value', 'metadata', 'session_id']),
    );
    expect(cols).not.toContain('duration_ms');
    expect(cols).not.toContain('success');
  });

  it('prepares + runs without throwing on an empty table', () => {
    expect(() => db.prepare(TOTAL_SQL).get()).not.toThrow();
    expect(() => db.prepare(BY_TYPE_SQL).all()).not.toThrow();

    const row = db.prepare(TOTAL_SQL).get() as { total: number; last_recorded: string | null };
    expect(row.total).toBe(0);
    expect(row.last_recorded).toBeNull();
    expect(db.prepare(BY_TYPE_SQL).all()).toEqual([]);
  });

  it('aggregates a total count and a metric_type breakdown when rows exist', () => {
    const insert = db.prepare(
      'INSERT INTO scraper_metrics (timestamp, metric_type, value) VALUES (?, ?, ?)',
    );
    insert.run('2026-01-01T00:00:00Z', 'request', 1);
    insert.run('2026-01-02T00:00:00Z', 'request', 1);
    insert.run('2026-01-03T00:00:00Z', 'cache_hit', 1);

    const row = db.prepare(TOTAL_SQL).get() as { total: number; last_recorded: string | null };
    expect(row.total).toBe(3);
    expect(row.last_recorded).toBe('2026-01-03T00:00:00Z');

    const byType = db.prepare(BY_TYPE_SQL).all() as Array<{ metric_type: string; count: number }>;
    const map = Object.fromEntries(byType.map((r) => [r.metric_type, r.count]));
    expect(map).toEqual({ request: 2, cache_hit: 1 });
  });

  it('the original buggy query DOES throw against the real schema (the bug we fixed)', () => {
    const buggy = `SELECT COUNT(*) AS total,
              AVG(duration_ms) AS avg_duration,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes
       FROM scraper_metrics`;
    expect(() => db.prepare(buggy).get()).toThrow();
  });
});
