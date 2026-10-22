import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictExpired, getCachedProduct, putCachedProduct } from '../cache';
import type { OrbitalProductDetail } from '../models';

/**
 * Cache eviction coverage for the polite-client work: expired rows must
 * self-clean on access (lazy-delete) so the `orbital_product_cache` table
 * doesn't accumulate stale entries for any slug that's re-queried, and the
 * sweep helper must still drop every expired row in bulk.
 *
 * Driven against `node:sqlite` (same engine as the shipping better-sqlite3,
 * but loadable under the Vitest Node) so the real query code runs unmodified.
 */

const CACHE_SCHEMA = /* sql */ `
CREATE TABLE orbital_product_cache (
  product_slug TEXT PRIMARY KEY NOT NULL,
  cached_data TEXT NOT NULL,
  last_fetched_timestamp TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  etag TEXT,
  response_time_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let db: Database;

function makeDb(): Database {
  const d = new DatabaseSync(':memory:');
  d.exec(CACHE_SCHEMA);
  return d as unknown as Database;
}

/** Insert a row directly with an explicit `expires_at` so we control TTL. */
function seedRow(slug: string, expiresAt: string, cachedData = '{"slug":"x"}'): void {
  db.prepare(
    `INSERT INTO orbital_product_cache
       (product_slug, cached_data, last_fetched_timestamp, expires_at, response_time_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(slug, cachedData, new Date().toISOString(), expiresAt, 10);
}

function countRows(): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM orbital_product_cache').get() as { n: number }
  ).n;
}

beforeEach(() => {
  db = makeDb();
});

afterEach(() => {
  (db as unknown as { close: () => void }).close();
  vi.useRealTimers();
});

describe('getCachedProduct lazy eviction', () => {
  it('returns the parsed product for a fresh (unexpired) row', () => {
    const detail = { slug: 'cool-pack' } as unknown as OrbitalProductDetail;
    const future = new Date(Date.now() + 60_000).toISOString();
    seedRow('cool-pack', future, JSON.stringify(detail));

    expect(getCachedProduct('cool-pack', db)).toEqual(detail);
    // The fresh row is left intact.
    expect(countRows()).toBe(1);
  });

  it('lazy-deletes an expired row on access and returns null', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    seedRow('stale-pack', past);

    expect(getCachedProduct('stale-pack', db)).toBeNull();
    // The expired row is gone — it no longer accumulates.
    expect(countRows()).toBe(0);
  });

  it('lazy-deletes a row whose TTL elapses between writes (fake timers)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-14T00:00:00.000Z'));

    const detail = { slug: 'ttl-pack' } as unknown as OrbitalProductDetail;
    putCachedProduct('ttl-pack', detail, 5, db);
    // Still inside the 24h TTL.
    expect(getCachedProduct('ttl-pack', db)).toEqual(detail);
    expect(countRows()).toBe(1);

    // Jump past the 24h TTL.
    vi.setSystemTime(new Date('2026-06-15T00:00:01.000Z'));
    expect(getCachedProduct('ttl-pack', db)).toBeNull();
    expect(countRows()).toBe(0);
  });

  it('evicts a row with corrupt JSON on access', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    seedRow('corrupt-pack', future, '{not valid json');

    expect(getCachedProduct('corrupt-pack', db)).toBeNull();
    expect(countRows()).toBe(0);
  });

  it('returns null without touching the table for an unknown slug', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    seedRow('present', future);

    expect(getCachedProduct('absent', db)).toBeNull();
    expect(countRows()).toBe(1);
  });
});

describe('evictExpired bulk sweep', () => {
  it('drops every expired row and keeps fresh ones', () => {
    seedRow('old-1', new Date(Date.now() - 10_000).toISOString());
    seedRow('old-2', new Date(Date.now() - 1).toISOString());
    seedRow('fresh', new Date(Date.now() + 60_000).toISOString());

    const removed = evictExpired(db);
    expect(removed).toBe(2);
    expect(countRows()).toBe(1);
    expect(
      db
        .prepare('SELECT product_slug FROM orbital_product_cache')
        .all()
        .map((r) => (r as { product_slug: string }).product_slug),
    ).toEqual(['fresh']);
  });
});
