import type { AssetFilter } from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  categoryCounts,
  clearAssetsForScanLocation,
  clearUserRating,
  countAssets,
  countSearchAssets,
  deleteAssets,
  ecosystemCounts,
  fabAssetCount,
  favoriteCount,
  getAssetById,
  getAssetStats,
  getDatabaseStats,
  getUserRating,
  learnCounts,
  listAssetCards,
  listAssets,
  listLearnAssets,
  marketplaceSourceCounts,
  pruneAssetsNotIn,
  searchAssets,
  setFavorite,
  setUserRating,
  toggleFavorite,
  totalCount,
  updateAssetDescription,
  wipeAllAssets,
} from '../assets';
import { createTestDb, linkMarketplace, seedAsset, seedAssets } from './fixtures/test-db';

let db: Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  (db as unknown as { close: () => void }).close();
});

const NO_FILTER: AssetFilter = {
  asset_type: null,
  tags: null,
  name_search: null,
  is_favorite: null,
  scan_location_id: null,
  date_range: null,
  category: null,
  ecosystem: null,
};

const filter = (overrides: Partial<AssetFilter>): AssetFilter => ({ ...NO_FILTER, ...overrides });

// ---------------------------------------------------------------------------
// FTS5 search + BM25 ranking — the headline query path.
// ---------------------------------------------------------------------------

describe('searchAssets (FTS5 + BM25)', () => {
  it('returns an empty array for blank / whitespace-only queries', () => {
    seedAsset(db, { name: 'Dragon Knight Pack' });
    expect(searchAssets(db, '')).toEqual([]);
    expect(searchAssets(db, '   ')).toEqual([]);
  });

  it('finds an asset by a token in its name', () => {
    seedAssets(db, [{ name: 'Dragon Knight Pack' }, { name: 'Castle Walls' }]);
    const results = searchAssets(db, 'dragon');
    expect(results.map((r) => r.name)).toEqual(['Dragon Knight Pack']);
  });

  it('ranks a name match above a tags-only match (weight 10 vs 5)', () => {
    const nameId = seedAsset(db, { name: 'Dragon Knight Pack', tags: '[]' });
    const tagId = seedAsset(db, { name: 'Generic Castle Pack', tags: '["dragon"]' });
    const results = searchAssets(db, 'dragon');
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(nameId);
    expect(results[1].id).toBe(tagId);
  });

  it('does prefix matching (a partial token matches the full word)', () => {
    seedAsset(db, { name: 'Dragon Knight Pack' });
    expect(searchAssets(db, 'drag').map((r) => r.name)).toEqual(['Dragon Knight Pack']);
  });

  it('treats multiple tokens as AND', () => {
    seedAssets(db, [
      { name: 'Dragon Knight Pack' },
      { name: 'Dragon Hatchling' },
      { name: 'Castle Knight' },
    ]);
    const results = searchAssets(db, 'dragon knight');
    expect(results.map((r) => r.name)).toEqual(['Dragon Knight Pack']);
  });

  it('sanitizes FTS operator characters instead of throwing a syntax error', () => {
    seedAsset(db, { name: 'Dragon Knight Pack' });
    // Stray quotes, parens and colons would be FTS5 operators if not escaped.
    expect(() => searchAssets(db, 'dragon"')).not.toThrow();
    expect(searchAssets(db, 'dragon"').map((r) => r.name)).toEqual(['Dragon Knight Pack']);
    expect(() => searchAssets(db, 'dragon:knight')).not.toThrow();
    expect(searchAssets(db, 'dragon:knight').map((r) => r.name)).toEqual(['Dragon Knight Pack']);
  });

  it('searches across orbital_title and orbital_seller_name too', () => {
    seedAsset(db, { name: 'Untitled', orbital_title: 'Quixel Megascans Rocks' });
    seedAsset(db, { name: 'Untitled 2', orbital_seller_name: 'Epic Games' });
    expect(searchAssets(db, 'megascans').map((r) => r.orbital_title)).toEqual([
      'Quixel Megascans Rocks',
    ]);
    expect(searchAssets(db, 'epic').map((r) => r.orbital_seller_name)).toEqual(['Epic Games']);
  });

  it('honors limit and offset', () => {
    seedAssets(db, [{ name: 'Dragon A' }, { name: 'Dragon B' }, { name: 'Dragon C' }]);
    expect(searchAssets(db, 'dragon', 2)).toHaveLength(2);
    expect(searchAssets(db, 'dragon', 100, 1).length).toBe(2);
  });

  // Search had no population guard of its own, so it could return rows the
  // browse path beside it insisted were not assets.
  it('excludes courses and soft-deleted packs, like every other listing', () => {
    seedAssets(db, [
      { name: 'Dragon Pack' },
      { name: 'Dragon Course', content_format: 'course' },
      { name: 'Dragon Renamed', missing_since: '2026-01-01T00:00:00Z' },
    ]);
    expect(searchAssets(db, 'dragon').map((r) => r.name)).toEqual(['Dragon Pack']);
  });

  it('intersects with a sidebar facet instead of ignoring it', () => {
    seedAssets(db, [
      { name: 'Dragon Fav', is_favorite: true, ecosystem: 'blender' },
      { name: 'Dragon Plain', ecosystem: 'blender' },
      { name: 'Dragon Fav Unreal', is_favorite: true, ecosystem: 'unreal_engine' },
    ]);
    const favorites = searchAssets(db, 'dragon', 100, 0, filter({ is_favorite: true }));
    expect(favorites.map((r) => r.name).sort()).toEqual(['Dragon Fav', 'Dragon Fav Unreal']);

    // Two axes at once — the composition the sidebar could not express before.
    const both = searchAssets(
      db,
      'dragon',
      100,
      0,
      filter({ is_favorite: true, ecosystem: 'blender' }),
    );
    expect(both.map((r) => r.name)).toEqual(['Dragon Fav']);
  });
});

describe('countSearchAssets', () => {
  it('counts what searchAssets would return, ignoring paging', () => {
    seedAssets(db, [{ name: 'Dragon A' }, { name: 'Dragon B' }, { name: 'Knight C' }]);
    expect(countSearchAssets(db, 'dragon')).toBe(2);
    // The status-bar bug this exists to prevent: paging must not change it.
    expect(searchAssets(db, 'dragon', 1)).toHaveLength(1);
    expect(countSearchAssets(db, 'dragon')).toBe(2);
  });

  it('applies the same facet filter', () => {
    seedAssets(db, [
      { name: 'Dragon Fav', is_favorite: true },
      { name: 'Dragon Plain' },
      { name: 'Dragon Course', content_format: 'course', is_favorite: true },
    ]);
    expect(countSearchAssets(db, 'dragon', filter({ is_favorite: true }))).toBe(1);
  });

  it('is zero for a query with no searchable tokens', () => {
    seedAssets(db, [{ name: 'Dragon A' }]);
    expect(countSearchAssets(db, '   ')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildAssetQuery — exercised through list / count.
// ---------------------------------------------------------------------------

describe('listAssets / countAssets filters', () => {
  beforeEach(() => {
    seedAssets(db, [
      {
        name: 'Sword',
        asset_type: 'weapon',
        is_favorite: true,
        scan_location_id: 1,
        file_size: 300,
        created_date: '2026-03-01T00:00:00Z',
        tags: '["fantasy","weapons"]',
        orbital_categories: '["Weapons"]',
        asset_ecosystem: 'unreal_engine',
      },
      {
        name: 'Shield',
        asset_type: 'weapon',
        is_favorite: false,
        scan_location_id: 2,
        file_size: 100,
        created_date: '2026-01-15T00:00:00Z',
        tags: '["fantasy"]',
        orbital_categories: '["Props"]',
        ecosystem: 'unity',
      },
      {
        name: 'Brick Material',
        asset_type: 'material',
        is_favorite: false,
        scan_location_id: 1,
        file_size: 200,
        created_date: '2026-02-10T00:00:00Z',
        orbital_title: 'PBR Brick Wall',
      },
    ]);
  });

  it('returns every row when no filter is given', () => {
    expect(listAssets(db)).toHaveLength(3);
    expect(countAssets(db)).toBe(3);
  });

  it('filters by asset_type', () => {
    expect(listAssets(db, { filter: filter({ asset_type: 'weapon' }) })).toHaveLength(2);
    expect(countAssets(db, filter({ asset_type: 'material' }))).toBe(1);
  });

  it('filters by is_favorite, and treats null as "no filter"', () => {
    expect(listAssets(db, { filter: filter({ is_favorite: true }) }).map((a) => a.name)).toEqual([
      'Sword',
    ]);
    expect(listAssets(db, { filter: filter({ is_favorite: false }) })).toHaveLength(2);
    expect(listAssets(db, { filter: filter({ is_favorite: null }) })).toHaveLength(3);
  });

  it('filters by scan_location_id', () => {
    expect(countAssets(db, filter({ scan_location_id: 1 }))).toBe(2);
    expect(countAssets(db, filter({ scan_location_id: 2 }))).toBe(1);
  });

  it('matches name_search against both name and orbital_title (LIKE)', () => {
    expect(listAssets(db, { filter: filter({ name_search: 'swor' }) }).map((a) => a.name)).toEqual([
      'Sword',
    ]);
    // Only the orbital_title carries "brick wall".
    expect(
      listAssets(db, { filter: filter({ name_search: 'brick wall' }) }).map((a) => a.name),
    ).toEqual(['Brick Material']);
  });

  it('filters by JSON tags (substring per tag, AND of all)', () => {
    expect(countAssets(db, filter({ tags: ['fantasy'] }))).toBe(2);
    expect(listAssets(db, { filter: filter({ tags: ['weapons'] }) }).map((a) => a.name)).toEqual([
      'Sword',
    ]);
    expect(countAssets(db, filter({ tags: ['fantasy', 'weapons'] }))).toBe(1);
  });

  it('filters by created_date range', () => {
    const inFeb = listAssets(db, {
      filter: filter({
        date_range: { start: '2026-02-01T00:00:00Z', end: '2026-02-28T00:00:00Z' },
      }),
    });
    expect(inFeb.map((a) => a.name)).toEqual(['Brick Material']);
  });

  it('filters by category via json_each over orbital_categories', () => {
    expect(listAssets(db, { filter: filter({ category: 'Weapons' }) }).map((a) => a.name)).toEqual([
      'Sword',
    ]);
    expect(countAssets(db, filter({ category: 'Props' }))).toBe(1);
  });

  it('filters by ecosystem, coalescing asset_ecosystem over the legacy column', () => {
    expect(countAssets(db, filter({ ecosystem: 'unreal_engine' }))).toBe(1); // asset_ecosystem
    expect(countAssets(db, filter({ ecosystem: 'unity' }))).toBe(1); // legacy ecosystem col
  });

  it('applies limit and offset', () => {
    expect(listAssets(db, { limit: 2 })).toHaveLength(2);
    expect(listAssets(db, { limit: 2, offset: 2 })).toHaveLength(1);
  });

  it('sorts by the requested SortOption', () => {
    expect(listAssets(db, { sort: 'name_asc' }).map((a) => a.name)).toEqual([
      'Brick Material',
      'Shield',
      'Sword',
    ]);
    expect(listAssets(db, { sort: 'size_desc' }).map((a) => a.file_size)).toEqual([300, 200, 100]);
  });
});

describe('listAssetCards', () => {
  it('projects only the card columns and normalizes booleans', () => {
    seedAsset(db, { name: 'Sword', is_favorite: true, fab_owned: true });
    const [card] = listAssetCards(db);
    expect(card.name).toBe('Sword');
    expect(card.is_favorite).toBe(true);
    expect(card.fab_owned).toBe(true);
    // Card projection carries tags + orbital_categories but not heavy columns.
    expect(card).toHaveProperty('tags');
    expect(card).toHaveProperty('orbital_categories');
    expect(card).not.toHaveProperty('description');
    expect(card).not.toHaveProperty('orbital_description');
  });
});

// ---------------------------------------------------------------------------
// Marketplace-match filter — `match_status` on buildAssetQuery.
// ---------------------------------------------------------------------------

describe('match_status filter', () => {
  beforeEach(() => {
    seedAsset(db, { name: 'Orbital A', matched_orbital_product_slug: 'foo' });
    seedAsset(db, { name: 'Orbital B', matched_orbital_product_slug: 'bar' });
    seedAsset(db, { name: 'Lonely Pack' }); // no orbital match
  });

  it('"orbital" returns only assets with a resolved orbital slug', () => {
    expect(
      listAssetCards(db, { filter: filter({ match_status: 'orbital' }) })
        .map((a) => a.name)
        .sort(),
    ).toEqual(['Orbital A', 'Orbital B']);
  });

  it('"unmatched" returns only assets without an orbital slug', () => {
    expect(
      listAssetCards(db, { filter: filter({ match_status: 'unmatched' }) }).map((a) => a.name),
    ).toEqual(['Lonely Pack']);
  });

  it('partitions the library: orbital + unmatched = the unfiltered total', () => {
    const orbital = countAssets(db, filter({ match_status: 'orbital' }));
    const unmatched = countAssets(db, filter({ match_status: 'unmatched' }));
    expect(orbital).toBe(2);
    expect(unmatched).toBe(1);
    expect(orbital + unmatched).toBe(countAssets(db, null));
  });
});

// ---------------------------------------------------------------------------
// Counts + aggregates.
// ---------------------------------------------------------------------------

describe('count + aggregate helpers', () => {
  beforeEach(() => {
    seedAssets(db, [
      {
        name: 'A',
        is_favorite: true,
        orbital_categories: '["Weapons","Props"]',
        asset_ecosystem: 'unreal_engine',
      },
      {
        name: 'B',
        is_favorite: false,
        orbital_categories: '["Weapons"]',
        asset_ecosystem: 'unity',
      },
      { name: 'FAB', scan_location_id: -1, asset_ecosystem: 'unreal_engine' },
      { name: 'Learn', content_format: 'video', is_favorite: true },
    ]);
    const m = seedAsset(db, { name: 'Matched', matched_orbital_product_slug: 'x' });
    linkMarketplace(db, m, 'orbital');
  });

  it('totalCount and favoriteCount exclude learn content', () => {
    // 4 non-learn assets (A, B, FAB, Matched).
    expect(totalCount(db)).toBe(4);
    // Only A is a favorite among non-learn rows ("Learn" is favorited but excluded).
    expect(favoriteCount(db)).toBe(1);
  });

  it('fabAssetCount counts the scan_location_id = -1 sentinel', () => {
    expect(fabAssetCount(db)).toBe(1);
  });

  it('categoryCounts tallies json array members of non-learn rows', () => {
    expect(categoryCounts(db)).toEqual({ Weapons: 2, Props: 1 });
  });

  it('ecosystemCounts groups by coalesced ecosystem, excluding learn content', () => {
    const counts = ecosystemCounts(db);
    expect(counts.unreal_engine).toBe(2);
    expect(counts.unity).toBe(1);
    expect(counts.unknown).toBe(1); // "Matched" has no ecosystem
  });

  it('marketplaceSourceCounts derives from the columns the enrich path writes', () => {
    // Derived (not from the never-written asset_marketplace_matches table):
    //   orbital = rows with a matched_orbital_product_slug ("Matched"),
    //   fab     = scan_location_id = -1 vault rows ("FAB").
    expect(marketplaceSourceCounts(db)).toEqual({ orbital: 1, fab: 1 });
  });

  it('marketplaceSourceCounts excludes Learn content and omits zero-count sources', () => {
    const learnDb = createTestDb();
    try {
      // An orbital-matched row that is Learn content must NOT be counted, and
      // with no FAB rows the `fab` key is omitted entirely (not 0).
      seedAsset(learnDb, {
        name: 'Learn Match',
        matched_orbital_product_slug: 'y',
        content_format: 'video',
      });
      seedAsset(learnDb, { name: 'Real Match', matched_orbital_product_slug: 'z' });
      expect(marketplaceSourceCounts(learnDb)).toEqual({ orbital: 1 });
    } finally {
      (learnDb as unknown as { close: () => void }).close();
    }
  });

  it('getAssetStats reports a coherent snapshot', () => {
    const stats = getAssetStats(db);
    expect(stats.total).toBe(4);
    expect(stats.favorites).toBe(1);
    expect(stats.with_orbital).toBe(1);
    expect(stats.unmatched).toBe(3); // A, B, FAB have no marketplace match / slug
    // The "Learn" row is a course, counted separately and never inside total.
    expect(stats.courses).toBe(1);
  });

  it('getAssetStats counts one population — courses never leak into pack totals', () => {
    const statsDb = createTestDb();
    try {
      seedAsset(statsDb, { name: 'Pack', is_favorite: true, fab_owned: true });
      seedAsset(statsDb, { name: 'Matched Pack', matched_orbital_product_slug: 'slug' });
      // A course that would previously have inflated with_orbital and
      // fab_owned while being excluded from total — the exact shape of the
      // "2,799 here, 3,010 there" disagreement.
      seedAsset(statsDb, {
        name: 'Course',
        content_format: 'video',
        matched_orbital_product_slug: 'course-slug',
        fab_owned: true,
        is_favorite: true,
      });

      const stats = getAssetStats(statsDb);
      expect(stats.total).toBe(2);
      expect(stats.courses).toBe(1);
      // Every pack-scoped field stays inside `total`.
      expect(stats.favorites).toBe(1);
      expect(stats.fab_owned).toBe(1);
      expect(stats.with_orbital).toBe(1);
      expect(stats.unmatched).toBe(1);
      expect(stats.with_orbital + stats.unmatched).toBe(stats.total);
    } finally {
      (statsDb as unknown as { close: () => void }).close();
    }
  });
});

// ---------------------------------------------------------------------------
// Mutations.
// ---------------------------------------------------------------------------

describe('mutations', () => {
  it('setFavorite / toggleFavorite flip the flag for the given ids', () => {
    const ids = seedAssets(db, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    setFavorite(db, [ids[0], ids[2]], true);
    expect(favoriteCount(db)).toBe(2);
    const changed = toggleFavorite(db, [ids[0]], false);
    expect(changed).toBe(1);
    expect(favoriteCount(db)).toBe(1);
  });

  it('setFavorite is a no-op for an empty id list', () => {
    seedAsset(db, { name: 'A' });
    expect(() => setFavorite(db, [], true)).not.toThrow();
    expect(favoriteCount(db)).toBe(0);
  });

  it('deleteAssets removes rows and returns the change count', () => {
    const ids = seedAssets(db, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    expect(deleteAssets(db, [ids[0], ids[1]])).toBe(2);
    expect(totalCount(db)).toBe(1);
    expect(deleteAssets(db, [])).toBe(0);
  });

  it('setUserRating clamps to 1..5 and upserts; getUserRating reads it back', () => {
    const id = seedAsset(db, { name: 'A' });
    expect(getUserRating(db, id)).toBeNull();

    setUserRating(db, id, 9);
    expect(getUserRating(db, id)).toBe(5); // clamped up

    setUserRating(db, id, 0);
    expect(getUserRating(db, id)).toBe(1); // clamped down

    setUserRating(db, id, 4);
    expect(getUserRating(db, id)).toBe(4); // updates existing note row
  });

  it('clearUserRating nulls out an existing rating', () => {
    const id = seedAsset(db, { name: 'A' });
    setUserRating(db, id, 5);
    clearUserRating(db, id);
    expect(getUserRating(db, id)).toBeNull();
  });

  it('updateAssetDescription writes through and reports the change count', () => {
    const id = seedAsset(db, { name: 'A', description: 'old' });
    expect(updateAssetDescription(db, id, 'new copy')).toBe(1);
    expect(getAssetById(db, id)?.description).toBe('new copy');
  });

  it('wipeAllAssets clears the table', () => {
    seedAssets(db, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
    expect(wipeAllAssets(db)).toBe(3);
    expect(totalCount(db)).toBe(0);
  });

  it('clearAssetsForScanLocation removes only that location’s rows', () => {
    seedAssets(db, [
      { name: 'L1a', scan_location_id: 1 },
      { name: 'L1b', scan_location_id: 1 },
      { name: 'L2', scan_location_id: 2 },
    ]);
    expect(clearAssetsForScanLocation(db, 1)).toBe(2);
    expect(listAssets(db).map((a) => a.name)).toEqual(['L2']);
  });

  it('pruneAssetsNotIn deletes only the location’s rows absent from the seen set', () => {
    seedAssets(db, [
      { name: 'Kept A', scan_location_id: 1, file_path: '/lib/a' },
      { name: 'Kept B', scan_location_id: 1, file_path: '/lib/b' },
      { name: 'Gone C', scan_location_id: 1, file_path: '/lib/c' }, // not in seen → pruned
      // Production declares `file_path TEXT NOT NULL UNIQUE`, so two locations
      // cannot share a path — this row previously reused '/lib/c', which the
      // real schema forbids. It still covers the point: the prune must not
      // touch another location's rows.
      { name: 'Other Loc', scan_location_id: 2, file_path: '/other/c' },
    ]);
    // Reconcile location 1 against the paths still on disk this scan.
    expect(pruneAssetsNotIn(db, 1, ['/lib/a', '/lib/b'])).toBe(1);
    expect(
      listAssets(db)
        .map((a) => a.name)
        .sort(),
    ).toEqual(['Kept A', 'Kept B', 'Other Loc']);
  });

  it('pruneAssetsNotIn is a no-op for an empty seen set (guards aborted scans)', () => {
    seedAssets(db, [
      { name: 'A', scan_location_id: 1, file_path: '/x/a' },
      { name: 'B', scan_location_id: 1, file_path: '/x/b' },
    ]);
    // An empty list must NOT prune the whole location (an aborted/empty walk).
    expect(pruneAssetsNotIn(db, 1, [])).toBe(0);
    expect(listAssets(db)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Curation must outlive a folder rename. Seven tables cascade off assets(id);
  // three of them hold things nothing can re-derive. A renamed pack looks
  // exactly like a deleted one to the prune, so a plain DELETE threw the user's
  // collections, tags and notes away and the pack returned as a fresh id.
  // -------------------------------------------------------------------------

  it('pruneAssetsNotIn soft-deletes a collection member instead of dropping it', () => {
    const id = seedAsset(db, { name: 'Curated', scan_location_id: 1, file_path: '/lib/old' });
    db.prepare("INSERT INTO collections (id, name) VALUES (1, 'hall of fame')").run();
    db.prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (1, ?)').run(id);

    // The pack was renamed on disk, so its old path is simply absent.
    expect(pruneAssetsNotIn(db, 1, ['/lib/other'])).toBe(1);

    // The row — and therefore the membership hanging off it — survives.
    const row = db.prepare('SELECT id, missing_since FROM assets WHERE id = ?').get(id) as
      | { id: number; missing_since: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.missing_since).toBeTruthy();
    expect((db.prepare('SELECT COUNT(*) n FROM collection_items').get() as { n: number }).n).toBe(
      1,
    );
  });

  it('pruneAssetsNotIn protects tags and notes the same way', () => {
    const tagged = seedAsset(db, { name: 'Tagged', scan_location_id: 1, file_path: '/lib/t' });
    const noted = seedAsset(db, { name: 'Noted', scan_location_id: 1, file_path: '/lib/n' });
    db.prepare("INSERT INTO asset_tags (asset_id, tag) VALUES (?, 'keep')").run(tagged);
    db.prepare('INSERT INTO asset_notes (asset_id, rating) VALUES (?, 4)').run(noted);

    expect(pruneAssetsNotIn(db, 1, ['/lib/elsewhere'])).toBe(2);
    expect((db.prepare('SELECT COUNT(*) n FROM asset_tags').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM asset_notes').get() as { n: number }).n).toBe(1);
  });

  it('pruneAssetsNotIn still hard-deletes uncurated phantoms', () => {
    seedAssets(db, [
      { name: 'Kept', scan_location_id: 1, file_path: '/lib/a' },
      { name: 'Phantom', scan_location_id: 1, file_path: '/lib/gone' },
    ]);
    expect(pruneAssetsNotIn(db, 1, ['/lib/a'])).toBe(1);
    // No curation attached, so it is noise — accumulating it is what the
    // prune exists to prevent.
    expect(listAssets(db).map((a) => a.name)).toEqual(['Kept']);
  });

  it('a curated row is stamped once, not re-stamped on every later scan', () => {
    const id = seedAsset(db, { name: 'Curated', scan_location_id: 1, file_path: '/lib/old' });
    db.prepare("INSERT INTO collections (id, name) VALUES (1, 'c')").run();
    db.prepare('INSERT INTO collection_items (collection_id, asset_id) VALUES (1, ?)').run(id);

    expect(pruneAssetsNotIn(db, 1, ['/lib/other'])).toBe(1);
    const first = (
      db.prepare('SELECT missing_since FROM assets WHERE id = ?').get(id) as {
        missing_since: string;
      }
    ).missing_since;

    // Second scan, still absent: already counted, so it must not report again.
    expect(pruneAssetsNotIn(db, 1, ['/lib/other'])).toBe(0);
    expect(
      (
        db.prepare('SELECT missing_since FROM assets WHERE id = ?').get(id) as {
          missing_since: string;
        }
      ).missing_since,
    ).toBe(first);
  });

  it('pruneAssetsNotIn can be re-run (temp table is dropped each call)', () => {
    seedAssets(db, [
      { name: 'A', scan_location_id: 1, file_path: '/y/a' },
      { name: 'B', scan_location_id: 1, file_path: '/y/b' },
    ]);
    expect(pruneAssetsNotIn(db, 1, ['/y/a', '/y/b'])).toBe(0);
    // Second invocation must not throw on a leftover temp table.
    expect(pruneAssetsNotIn(db, 1, ['/y/a'])).toBe(1);
    expect(listAssets(db).map((a) => a.name)).toEqual(['A']);
  });
});

// ---------------------------------------------------------------------------
// getAssetById + database stats.
// ---------------------------------------------------------------------------

describe('getAssetById + getDatabaseStats', () => {
  it('getAssetById returns the row or null', () => {
    const id = seedAsset(db, { name: 'Found Me', file_size: 99 });
    expect(getAssetById(db, id)?.name).toBe('Found Me');
    expect(getAssetById(db, 999_999)).toBeNull();
  });

  it('getAssetById normalizes boolean columns', () => {
    const id = seedAsset(db, { name: 'A', is_favorite: true, fab_owned: false });
    const asset = getAssetById(db, id);
    expect(asset?.is_favorite).toBe(true);
    expect(asset?.fab_owned).toBe(false);
  });

  it('getDatabaseStats aggregates counts and total size', () => {
    seedAssets(db, [
      { name: 'A', file_size: 100 },
      { name: 'B', file_size: 250 },
    ]);
    const stats = getDatabaseStats(db);
    expect(stats.asset_count).toBe(2);
    expect(stats.size_bytes).toBe(350);
    // Empty support tables still report a numeric zero rather than null.
    expect(stats.location_count).toBe(0);
    expect(stats.collection_count).toBe(0);
    expect(stats.tag_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Learn-tab queries (content_format IS NOT NULL).
// ---------------------------------------------------------------------------

describe('Learn-tab queries', () => {
  beforeEach(() => {
    seedAssets(db, [
      {
        name: 'Blueprint Basics',
        content_format: 'video',
        tutorial_source: 'youtube',
        ecosystem: 'unreal_engine',
        completion_status: 'completed',
      },
      {
        name: 'Sculpting Guide',
        content_format: 'pdf',
        tutorial_source: 'gumroad',
        ecosystem: 'blender',
        completion_status: 'in_progress',
      },
      {
        name: 'Lighting Deep Dive',
        content_format: 'video',
        tutorial_source: 'youtube',
        ecosystem: 'blender',
      },
      { name: 'A Regular Pack' }, // not learn content → excluded everywhere
    ]);
  });

  it('listLearnAssets returns only content with a content_format', () => {
    expect(listLearnAssets(db)).toHaveLength(3);
  });

  it('listLearnAssets filters by format / source / software', () => {
    expect(listLearnAssets(db, { format: 'video' })).toHaveLength(2);
    expect(listLearnAssets(db, { source: 'gumroad' })).toHaveLength(1);
    expect(listLearnAssets(db, { software: 'blender' })).toHaveLength(2);
  });

  it('listLearnAssets honors limit and offset', () => {
    // 3 learn rows total; page through them.
    expect(listLearnAssets(db, { limit: 2 })).toHaveLength(2);
    expect(listLearnAssets(db, { limit: 2, offset: 2 })).toHaveLength(1);
  });

  it('listLearnAssets returns the whole library when no limit is passed', () => {
    // Regression: a default LIMIT would silently truncate un-paginated callers
    // (LearnView via the tRPC learn router) once a library exceeds the cap.
    const extra = 150; // comfortably above DEFAULT_LIMIT (100)
    seedAssets(
      db,
      Array.from({ length: extra }, (_, i) => ({
        name: `extra-learn-${i}`,
        content_format: 'video',
      })),
    );
    // 3 pre-seeded learn rows + `extra` = the full set, with no cap applied.
    expect(listLearnAssets(db)).toHaveLength(3 + extra);
    expect(listLearnAssets(db, {})).toHaveLength(3 + extra);
  });

  it('learnCounts tallies totals, facets, and completion buckets', () => {
    const counts = learnCounts(db);
    expect(counts.total).toBe(3);
    expect(counts.by_format).toEqual({ video: 2, pdf: 1 });
    expect(counts.by_source).toEqual({ youtube: 2, gumroad: 1 });
    expect(counts.by_software).toEqual({ unreal_engine: 1, blender: 2 });
    expect(counts.completed).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.not_started).toBe(1); // the video with no completion_status
  });
});
