import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbitalRequestError, RateLimitError } from '../client';

/**
 * enrichOrbital must only mark a row `orbital_match_attempted` on a definitive
 * answer (matched, or confirmed no-match). Network trouble (429/5xx/transport/
 * open breaker) leaves the row for the next run, and an open breaker stops the
 * run instead of burning through every remaining candidate.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  matchAssetName: vi.fn(),
  getProduct: vi.fn(),
}));

vi.mock('../../db', () => ({ openDatabase: () => h.db }));
vi.mock('../matcher', () => ({ matchAssetName: h.matchAssetName }));
vi.mock('../product', () => ({ getProduct: h.getProduct }));

import { enrichOneOrbital, enrichOrbital } from '../enrich';

const SCHEMA = /* sql */ `
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'unreal_pack',
  content_format TEXT,
  scan_location_id INTEGER NOT NULL DEFAULT 1,
  orbital_match_attempted INTEGER NOT NULL DEFAULT 0,
  orbital_title TEXT,
  orbital_description TEXT,
  matched_orbital_product_slug TEXT,
  orbital_match_confidence REAL,
  orbital_match_type TEXT,
  orbital_technical_details TEXT,
  orbital_seller_name TEXT,
  orbital_price REAL,
  orbital_release_date TEXT,
  orbital_last_modified TEXT,
  orbital_rating_average REAL,
  orbital_rating_count INTEGER,
  orbital_categories TEXT,
  orbital_supported_versions TEXT,
  orbital_gallery_images TEXT,
  orbital_thumbnail_url TEXT,
  orbital_source_url TEXT,
  orbital_last_checked_timestamp TEXT
);
CREATE TABLE orbital_match_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  product_slug TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

function attempted(): Record<string, number> {
  const rows = (h.db as Database)
    .prepare('SELECT name, orbital_match_attempted AS a FROM assets ORDER BY id')
    .all() as { name: string; a: number }[];
  return Object.fromEntries(rows.map((r) => [r.name, r.a]));
}

beforeEach(() => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  for (const n of ['A', 'B', 'C']) d.prepare('INSERT INTO assets (name) VALUES (?)').run(n);
  h.db = d;
  h.matchAssetName.mockReset();
  h.getProduct.mockReset();
});

afterEach(() => {
  (h.db as unknown as { close: () => void }).close();
});

const quiet = { onProgress: () => {} };

describe('enrichOrbital attempted-marking', () => {
  it('marks a confirmed no-match as attempted', async () => {
    h.matchAssetName.mockResolvedValue([]);
    const r = await enrichOrbital(quiet);
    expect(r.unmatched).toBe(3);
    expect(attempted()).toEqual({ A: 1, B: 1, C: 1 });
  });

  it('marks a confirmed 404 (getProduct null) as attempted', async () => {
    h.matchAssetName.mockResolvedValue([{ strength: 'exact', score: 1, item: { slug: 's' } }]);
    h.getProduct.mockResolvedValue(null);
    await enrichOrbital(quiet);
    expect(attempted()).toEqual({ A: 1, B: 1, C: 1 });
  });

  it('does not mark rows attempted when the breaker is open, and stops the run', async () => {
    h.matchAssetName.mockRejectedValue(
      new RateLimitError('breaker open', 60_000, { breakerOpen: true }),
    );
    const events: string[] = [];
    const r = await enrichOrbital({ onProgress: (p) => events.push(p.phase) });
    expect(attempted()).toEqual({ A: 0, B: 0, C: 0 });
    expect(h.matchAssetName).toHaveBeenCalledTimes(1);
    expect(r.interrupted).toBe(true);
    expect(events).toContain('error');
    expect(events.at(-1)).toBe('done');
  });

  it('does not mark a row attempted on a 5xx/429/transport failure and keeps going', async () => {
    h.matchAssetName
      .mockRejectedValueOnce(new RateLimitError('503', 0, { status: 503 }))
      .mockResolvedValue([]);
    const r = await enrichOrbital(quiet);
    expect(r.failed).toBe(1);
    expect(attempted()).toEqual({ A: 0, B: 1, C: 1 });
  });

  it('still marks a non-network failure (bad request/response) as attempted', async () => {
    h.matchAssetName
      .mockRejectedValueOnce(new OrbitalRequestError('Orbital 403: /x', 403))
      .mockResolvedValue([]);
    const r = await enrichOrbital(quiet);
    expect(r.failed).toBe(1);
    expect(attempted()).toEqual({ A: 1, B: 1, C: 1 });
  });

  it('does not mark a row attempted when the retry deadline is exceeded', async () => {
    h.matchAssetName
      .mockRejectedValueOnce(new RateLimitError('Orbital request deadline exceeded: /x', 0))
      .mockResolvedValue([]);
    const r = await enrichOrbital(quiet);
    expect(r.failed).toBe(1);
    expect(attempted()).toEqual({ A: 0, B: 1, C: 1 });
  });
});

describe('match decisions from the Match view', () => {
  const product = (slug: string) => ({ slug, title: slug });
  const cand = (slug: string, score = 0.9, strength: string = 'high') => ({
    item: { slug, title: slug },
    score,
    strength,
  });
  const attemptedOf = (name: string) =>
    (
      (h.db as Database)
        .prepare('SELECT orbital_match_attempted AS a FROM assets WHERE name = ?')
        .get(name) as { a: number }
    ).a;
  const slugOf = (name: string) =>
    (
      (h.db as Database)
        .prepare('SELECT matched_orbital_product_slug AS s FROM assets WHERE name = ?')
        .get(name) as { s: string | null }
    ).s;

  it('skips a listing the user rejected and takes the next one', async () => {
    (h.db as Database)
      .prepare("INSERT INTO orbital_match_rejections (asset_id, product_slug) VALUES (1, 'wrong')")
      .run();
    h.matchAssetName.mockResolvedValue([cand('wrong'), cand('right', 0.8)]);
    h.getProduct.mockImplementation(async (slug: string) => product(slug));
    await enrichOrbital(quiet);
    expect(slugOf('A')).toBe('right');
    // Other assets have no rejections, so their top candidate stands.
    expect(slugOf('B')).toBe('wrong');
  });

  it('counts an asset as unmatched when every candidate was rejected', async () => {
    (h.db as Database)
      .prepare("INSERT INTO orbital_match_rejections (asset_id, product_slug) VALUES (1, 'only')")
      .run();
    h.matchAssetName.mockResolvedValue([cand('only')]);
    h.getProduct.mockImplementation(async (slug: string) => product(slug));
    const r = await enrichOrbital(quiet);
    expect(slugOf('A')).toBeNull();
    expect(attemptedOf('A')).toBe(1);
    expect(r.unmatched).toBe(1);
    expect(r.matched).toBe(2);
  });

  it('leaves a reviewed pack for the Match view when the runner-up is weak', async () => {
    (h.db as Database)
      .prepare("INSERT INTO orbital_match_rejections (asset_id, product_slug) VALUES (1, 'wrong')")
      .run();
    h.matchAssetName.mockResolvedValue([cand('wrong'), cand('maybe', 0.5, 'low')]);
    h.getProduct.mockImplementation(async (slug: string) => product(slug));
    await enrichOrbital(quiet);
    expect(slugOf('A')).toBeNull();
    // A pack nobody reviewed keeps its top candidate, as before.
    expect(slugOf('B')).toBe('wrong');
  });

  it('leaves a dismissed asset out of the bulk run', async () => {
    (h.db as Database)
      .prepare('INSERT INTO orbital_match_rejections (asset_id, product_slug) VALUES (2, NULL)')
      .run();
    h.matchAssetName.mockResolvedValue([cand('pack')]);
    h.getProduct.mockImplementation(async (slug: string) => product(slug));
    const r = await enrichOrbital(quiet);
    expect(r.total).toBe(2);
    expect(slugOf('B')).toBeNull();
  });

  it('applies the same rule to a single automatic match', async () => {
    (h.db as Database)
      .prepare("INSERT INTO orbital_match_rejections (asset_id, product_slug) VALUES (3, 'wrong')")
      .run();
    h.matchAssetName.mockResolvedValue([cand('wrong'), cand('right', 0.8)]);
    h.getProduct.mockImplementation(async (slug: string) => product(slug));
    await enrichOneOrbital(3);
    expect(slugOf('C')).toBe('right');
  });
});
