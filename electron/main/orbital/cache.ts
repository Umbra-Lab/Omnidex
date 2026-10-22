import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db';
import type { OrbitalProductDetail } from './models';

/**
 * Persistent cache for Orbital Market product responses backed by the
 * `orbital_product_cache` table (created by migration 20251011101430).
 *
 * TTL matches the Tauri cache policy — 24 hours. The memory note
 * "Orbital Market = ~1 call/sec human pace, 300ms is safe" hints at the
 * budget we're trying to protect: a scan that matches 500 assets to 100
 * unique products should hit the API once per product then never again
 * within the window.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheRow {
  product_slug: string;
  cached_data: string;
  last_fetched_timestamp: string;
  expires_at: string;
  etag: string | null;
  response_time_ms: number | null;
}

export function getCachedProduct(
  slug: string,
  db: Database = openDatabase(),
): OrbitalProductDetail | null {
  const row = db
    .prepare('SELECT cached_data, expires_at FROM orbital_product_cache WHERE product_slug = ?')
    .get(slug) as { cached_data: string; expires_at: string } | undefined;

  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    // Lazy-delete on expiry: drop the stale row so expired entries self-clean
    // on next access and don't accumulate for any slug that's re-queried.
    db.prepare('DELETE FROM orbital_product_cache WHERE product_slug = ?').run(slug);
    return null;
  }

  try {
    return JSON.parse(row.cached_data) as OrbitalProductDetail;
  } catch {
    // Corrupt JSON — evict so a fresh fetch can repopulate.
    db.prepare('DELETE FROM orbital_product_cache WHERE product_slug = ?').run(slug);
    return null;
  }
}

export function putCachedProduct(
  slug: string,
  data: OrbitalProductDetail,
  responseTimeMs?: number,
  db: Database = openDatabase(),
): void {
  const now = Date.now();
  const expires = new Date(now + CACHE_TTL_MS).toISOString();
  const nowIso = new Date(now).toISOString();

  db.prepare(
    `INSERT INTO orbital_product_cache (
       product_slug, cached_data, last_fetched_timestamp, expires_at, response_time_ms
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(product_slug) DO UPDATE SET
       cached_data = excluded.cached_data,
       last_fetched_timestamp = excluded.last_fetched_timestamp,
       expires_at = excluded.expires_at,
       response_time_ms = excluded.response_time_ms`,
  ).run(slug, JSON.stringify(data), nowIso, expires, responseTimeMs ?? null);
}

export function evictExpired(db: Database = openDatabase()): number {
  const result = db
    .prepare('DELETE FROM orbital_product_cache WHERE expires_at < ?')
    .run(new Date().toISOString());
  return result.changes;
}

export function cacheStats(db: Database = openDatabase()): {
  total: number;
  expired: number;
  avgResponseMs: number | null;
} {
  const now = new Date().toISOString();
  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM orbital_product_cache').get() as { n: number }
  ).n;
  const expired = (
    db.prepare('SELECT COUNT(*) AS n FROM orbital_product_cache WHERE expires_at < ?').get(now) as {
      n: number;
    }
  ).n;
  const avgRow = db
    .prepare(
      'SELECT AVG(response_time_ms) AS avg FROM orbital_product_cache WHERE response_time_ms IS NOT NULL',
    )
    .get() as { avg: number | null } | undefined;
  return { total, expired, avgResponseMs: avgRow?.avg ?? null };
}

// Type-only export to surface the row shape for future callers that want
// direct access without re-declaring.
export type { CacheRow };
