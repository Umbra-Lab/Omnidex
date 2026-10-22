import type { Asset, AssetCardData, AssetFilter, SortOption } from '@omnidex/types/db';
import { DEFAULT_SORT, SORT_OPTION_SQL } from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';
import { normalizeRow, normalizeRows, toSqliteBool } from './row-helpers';

/**
 * Query layer for the `assets` table. Mirrors behavior of
 * `src-tauri/src/services/query_builder.rs` + `asset_service.rs` but runs
 * in-process under the Electron main, reached via IPC from the renderer.
 *
 * Scope of this module (Phase 1):
 *   - list (filtered), listCards (projection), getById, search (FTS5), favorite
 *
 * More mutations (tags, delete, bulk ops) land alongside the command ports in
 * Phase 2.
 */

interface ListOptions {
  filter?: AssetFilter | null;
  limit?: number;
  offset?: number;
  sort?: SortOption;
}

const DEFAULT_LIMIT = 100;
const CARD_COLUMNS = `
  id, name, orbital_title, asset_type, file_size, file_path,
  thumbnail_path, orbital_thumbnail_url,
  orbital_rating_average, orbital_rating_count,
  orbital_price, orbital_source_url, orbital_seller_name,
  is_favorite, created_date, fab_owned,
  tags, orbital_categories,
  asset_ecosystem, ecosystem, orbital_supported_versions,
  scan_location_id, matched_orbital_product_slug, missing_since
`;

export function getAssetById(db: Database, id: number): Asset | null {
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return normalizeRow<Asset>(row);
}

export function listAssets(db: Database, opts: ListOptions = {}): Asset[] {
  const { sql, params } = buildAssetQuery(
    '*',
    opts.filter ?? null,
    opts.sort ?? DEFAULT_SORT,
    opts.limit ?? DEFAULT_LIMIT,
    opts.offset ?? 0,
  );
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return normalizeRows<Asset>(rows);
}

export function listAssetCards(db: Database, opts: ListOptions = {}): AssetCardData[] {
  const { sql, params } = buildAssetQuery(
    CARD_COLUMNS,
    opts.filter ?? null,
    opts.sort ?? DEFAULT_SORT,
    opts.limit ?? DEFAULT_LIMIT,
    opts.offset ?? 0,
  );
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return normalizeRows<AssetCardData>(rows);
}

export function countAssets(db: Database, filter: AssetFilter | null = null): number {
  const { sql, params } = buildAssetQuery('COUNT(*) AS n', filter, null, null, null);
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Count assets grouped by orbital_categories (a JSON array column). Uses
 * SQLite's `json_each` to explode the array and tally category frequency —
 * mirrors the Rust `get_category_counts` command.
 */
export function categoryCounts(db: Database): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT json_each.value AS category, COUNT(*) AS count
       FROM assets, json_each(assets.orbital_categories)
       WHERE assets.orbital_categories IS NOT NULL
         AND assets.content_format IS NULL
       GROUP BY json_each.value
       ORDER BY count DESC`,
    )
    .all() as { category: string; count: number }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.category] = row.count;
  return out;
}

export function ecosystemCounts(db: Database): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(asset_ecosystem, ecosystem, 'unknown') AS eco, COUNT(*) AS count
       FROM assets
       WHERE content_format IS NULL
       GROUP BY eco`,
    )
    .all() as { eco: string; count: number }[];
  const out: Record<string, number> = {};
  for (const row of rows) out[row.eco] = row.count;
  return out;
}

/**
 * Per-source asset counts for the sidebar's marketplace filters.
 *
 * The previous implementation read `asset_marketplace_matches`, but the
 * Electron enrich pipeline never writes that table (only the legacy
 * `normalize_asset_schema` migration creates it), so it always returned `{}`.
 * Derive instead from the columns the enrich paths actually populate:
 *
 *   - `orbital`: rows with a resolved `matched_orbital_product_slug`
 *     (`orbital/enrich.ts` `UPDATE_SQL`).
 *   - `fab`: FAB-vault rows, keyed on the `scan_location_id = -1` sentinel
 *     (`fabAssetCount` + the `AssetsView` `source === 'fab'` mapping both use
 *     this), so the count matches the bucket the sidebar actually filters to.
 *
 * Learn content (`content_format IS NOT NULL`) is excluded to stay consistent
 * with every other non-Learn count. `epic` is intentionally omitted: no
 * distinct epic-owned signal is written on `assets` today, and fabricating one
 * (or aliasing FAB) would mislead the filter. Add it here only once a real
 * epic-ownership column exists.
 */
export function marketplaceSourceCounts(db: Database): Record<string, number> {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const orbital = one(
    `SELECT COUNT(*) AS n FROM assets
     WHERE matched_orbital_product_slug IS NOT NULL AND content_format IS NULL`,
  );
  const fab = one(
    `SELECT COUNT(*) AS n FROM assets
     WHERE scan_location_id = -1 AND content_format IS NULL`,
  );
  const out: Record<string, number> = {};
  if (orbital > 0) out.orbital = orbital;
  if (fab > 0) out.fab = fab;
  return out;
}

export interface DuplicateInfo {
  /** Other rows carrying the same pack name. Excludes the asset asked about. */
  readonly count: number;
  /** Scan locations those other copies live in, deduplicated. */
  readonly scan_location_ids: readonly number[];
}

/**
 * Find other copies of a pack across scan locations.
 *
 * A library assembled from seven folders across three drives accumulates the
 * same pack in several places — "GrandBazaar" sits in the Telegram inbox and
 * the organized library at once. The inspector could not say so, which is the
 * provenance gap: the app's whole job is knowing where things came from.
 *
 * Matched on `name` because that is the only identity a scanned folder has
 * before enrichment, which is exactly the un-enriched majority that needs
 * this. Two genuinely different packs sharing a folder name will read as
 * duplicates; that is the honest answer to "is this name ambiguous in my
 * library", and the row lists the locations so the user can judge.
 */
export function duplicatesOf(db: Database, id: number): DuplicateInfo {
  const self = db.prepare('SELECT name FROM assets WHERE id = ?').get(id) as
    | { name: string }
    | undefined;
  if (!self) return { count: 0, scan_location_ids: [] };

  const count = (
    db
      .prepare('SELECT COUNT(*) AS n FROM assets WHERE name = ? AND id != ?')
      .get(self.name, id) as {
      n: number;
    }
  ).n;
  if (count === 0) return { count: 0, scan_location_ids: [] };

  const rows = db
    .prepare(
      `SELECT DISTINCT scan_location_id FROM assets
       WHERE name = ? AND id != ? AND scan_location_id IS NOT NULL`,
    )
    .all(self.name, id) as { scan_location_id: number }[];
  return { count, scan_location_ids: rows.map((r) => r.scan_location_id) };
}

export function favoriteCount(db: Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM assets WHERE is_favorite = 1 AND content_format IS NULL')
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function totalCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE content_format IS NULL').get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/**
 * Count FAB-owned assets — rows with `scan_location_id = -1`, which is the
 * sentinel value the Tauri `fab_commands` uses for Epic-launched vault items.
 */
export function fabAssetCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE scan_location_id = -1').get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

// ---- Learn tab -----------------------------------------------------------

interface LearnAssetsFilter {
  format?: string | null;
  source?: string | null;
  software?: string | null;
  limit?: number | null;
  offset?: number | null;
}

const LEARN_COLUMNS = `
  id, name, file_path, file_size, thumbnail_path, orbital_thumbnail_url,
  content_format, completion_status, tutorial_source, ecosystem,
  created_date, modified_date
`;

export function listLearnAssets(db: Database, filter: LearnAssetsFilter = {}): unknown[] {
  const where: string[] = ['content_format IS NOT NULL'];
  const params: unknown[] = [];
  if (filter.format) {
    where.push('content_format = ?');
    params.push(filter.format);
  }
  if (filter.source) {
    where.push('tutorial_source = ?');
    params.push(filter.source);
  }
  if (filter.software) {
    where.push('ecosystem = ?');
    params.push(filter.software);
  }
  // Bound the result set only when a caller opts into pagination by passing an
  // explicit `limit`. The Learn surfaces (LearnView via the tRPC learn router)
  // are not paginated and pass no limit, so they must keep receiving the full
  // Learn library — applying a default cap here would silently hide rows from
  // those un-paginated consumers.
  let pagination = '';
  if (filter.limit != null) {
    pagination = ' LIMIT ? OFFSET ?';
    params.push(filter.limit, filter.offset ?? 0);
  }
  const sql = `SELECT ${LEARN_COLUMNS} FROM assets WHERE ${where.join(
    ' AND ',
  )} ORDER BY modified_date DESC${pagination}`;
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return normalizeRows(rows);
}

export interface LearnCounts {
  total: number;
  by_format: Record<string, number>;
  by_source: Record<string, number>;
  by_software: Record<string, number>;
  completed: number;
  in_progress: number;
  not_started: number;
}

export function learnCounts(db: Database): LearnCounts {
  const base = 'FROM assets WHERE content_format IS NOT NULL';
  const total = (
    db.prepare(`SELECT COUNT(*) AS n ${base}`).get() as {
      n: number;
    }
  ).n;
  const formatRows = db
    .prepare(`SELECT content_format AS k, COUNT(*) AS n ${base} GROUP BY content_format`)
    .all() as { k: string; n: number }[];
  const sourceRows = db
    .prepare(
      `SELECT tutorial_source AS k, COUNT(*) AS n ${base} AND tutorial_source IS NOT NULL GROUP BY tutorial_source`,
    )
    .all() as { k: string; n: number }[];
  const softwareRows = db
    .prepare(
      `SELECT ecosystem AS k, COUNT(*) AS n ${base} AND ecosystem IS NOT NULL GROUP BY ecosystem`,
    )
    .all() as { k: string; n: number }[];
  const completed = (
    db.prepare(`SELECT COUNT(*) AS n ${base} AND completion_status = 'completed'`).get() as {
      n: number;
    }
  ).n;
  const inProgress = (
    db.prepare(`SELECT COUNT(*) AS n ${base} AND completion_status = 'in_progress'`).get() as {
      n: number;
    }
  ).n;
  const notStarted = total - completed - inProgress;

  const toMap = (rows: { k: string; n: number }[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of rows) out[r.k] = r.n;
    return out;
  };

  return {
    total,
    by_format: toMap(formatRows),
    by_source: toMap(sourceRows),
    by_software: toMap(softwareRows),
    completed,
    in_progress: inProgress,
    not_started: notStarted,
  };
}

/**
 * FTS5-ranked search. Escapes user input for the MATCH operator by wrapping
 * each whitespace-separated token in quotes (the FTS5 "phrase" syntax) and
 * appending `*` for prefix matching. BM25 column weights: name=10, tags=5,
 * description=1, orbital_title=8, orbital_description=2, orbital_seller_name=2.
 */
export function searchAssets(
  db: Database,
  query: string,
  limit = DEFAULT_LIMIT,
  offset = 0,
  filter: AssetFilter | null = null,
): AssetCardData[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  // The FTS5 virtual table exposes the same column names as the base
  // table. Qualify every projected column so the JOIN doesn't raise
  // "ambiguous column name".
  const qualifiedCards = CARD_COLUMNS.split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `assets.${c}`)
    .join(', ');
  // Same predicates the browse path uses, so a facet keeps applying while a
  // query is typed and search cannot surface a course or a soft-deleted pack.
  const { where, params } = assetFilterClauses(filter);
  const sql = `
    SELECT ${qualifiedCards}
    FROM assets
    JOIN assets_fts ON assets_fts.rowid = assets.id
    WHERE assets_fts MATCH ? AND ${where.join(' AND ')}
    ORDER BY bm25(assets_fts, 10.0, 1.0, 5.0, 8.0, 2.0, 2.0)
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(sql).all(ftsQuery, ...params, limit, offset) as Record<string, unknown>[];
  return normalizeRows<AssetCardData>(rows);
}

/**
 * How many rows `searchAssets` would return, ignoring paging.
 *
 * The status bar owns the library's one authoritative count, and while a query
 * was active it published the *browse* count — "2,799 shown" above twelve
 * results. Same MATCH, same filter clauses, no ORDER BY (bm25 ranking costs
 * nothing to a COUNT).
 */
export function countSearchAssets(
  db: Database,
  query: string,
  filter: AssetFilter | null = null,
): number {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return 0;
  const { where, params } = assetFilterClauses(filter);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM assets
       JOIN assets_fts ON assets_fts.rowid = assets.id
       WHERE assets_fts MATCH ? AND ${where.join(' AND ')}`,
    )
    .get(ftsQuery, ...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function setFavorite(db: Database, ids: number[], favorite: boolean): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const sql = `UPDATE assets SET is_favorite = ? WHERE id IN (${placeholders})`;
  const stmt = db.prepare(sql);
  stmt.run(toSqliteBool(favorite), ...ids);
}

export function deleteAssets(db: Database, ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`DELETE FROM assets WHERE id IN (${placeholders})`);
  const result = stmt.run(...ids);
  return result.changes;
}

/** Clear every asset row from the database (keeps schema). */
export function wipeAllAssets(db: Database): number {
  const res = db.prepare('DELETE FROM assets').run();
  return res.changes;
}

export function clearAssetsForScanLocation(db: Database, locationId: number): number {
  return db.prepare('DELETE FROM assets WHERE scan_location_id = ?').run(locationId).changes;
}

/**
 * Reconciliation prune: delete every row for `locationId` whose `file_path` is
 * NOT in `keepPaths` — i.e. assets that vanished from disk since the last scan.
 *
 * Unlike `clearAssetsForScanLocation` (which nukes ALL rows for the location),
 * this is the *complement* delete the scanner runs after a successful walk so
 * the catalog tracks the filesystem instead of accumulating phantom rows for
 * deleted/moved packs.
 *
 * The seen-path set is staged into a TEMP table rather than an inline
 * `NOT IN (?, ?, …)` list to sidestep SQLite's ~999 host-parameter limit
 * (`SQLITE_MAX_VARIABLE_NUMBER`) on large libraries — the TEMP-table form is
 * unbounded. An empty `keepPaths` would prune the entire location, which is a
 * caller mistake (an aborted/empty walk must not reconcile), so we no-op and
 * return 0 instead.
 *
 * Caller contract: only invoke after a *complete* (non-aborted) walk, ideally
 * inside the same transaction as the upsert loop so a crash can't leave a
 * half-pruned catalog.
 *
 * CURATED ROWS ARE NOT DELETED. Seven tables cascade off `assets(id)`, three of
 * which hold things the user typed and nothing can re-derive: collection
 * membership, tags, and notes/ratings. A pack that is merely *renamed* looks
 * identical to a deleted one from here — its old path simply stops appearing —
 * so a plain DELETE silently threw the user's curation away and the pack came
 * back on the next scan as a brand-new id with none of it. That is how this
 * library reached 3,010 rows on a sqlite_sequence of 16,098 with every
 * curation table empty.
 *
 * So a row that carries curation is stamped `missing_since` and kept; the id
 * survives, and re-seeing the path clears the stamp (see the scanner's upsert).
 * Everything else is still hard-deleted — an uncurated phantom row is just
 * noise, and keeping it would be the accumulation this prune exists to stop.
 *
 * Returns the number of rows removed from the catalog's active set — hard
 * deletes plus newly-stamped rows — because that is what the caller reports as
 * "pruned" and both mean "no longer on disk".
 */
export function pruneAssetsNotIn(db: Database, locationId: number, keepPaths: string[]): number {
  if (keepPaths.length === 0) return 0;
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _scan_seen (path TEXT PRIMARY KEY)');
  try {
    db.exec('DELETE FROM _scan_seen');
    const insert = db.prepare('INSERT OR IGNORE INTO _scan_seen (path) VALUES (?)');
    for (const path of keepPaths) insert.run(path);

    const vanished = `
      scan_location_id = ?
      AND file_path NOT IN (SELECT path FROM _scan_seen)`;

    // Anything the user put there by hand. is_favorite is deliberately absent:
    // it lives on the asset row, so it dies with a hard delete anyway and
    // re-appears as `false` — worth protecting, but cheap enough to lose that
    // it does not justify keeping a phantom row on its own. Membership, tags
    // and notes cannot be reconstructed at all.
    const curated = `(
      EXISTS (SELECT 1 FROM collection_items ci WHERE ci.asset_id = assets.id)
      OR EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = assets.id)
      OR EXISTS (SELECT 1 FROM asset_notes n WHERE n.asset_id = assets.id)
      -- A match decision is user-typed and unreconstructable, exactly like a
      -- tag. Without this line a rename hard-deletes the row, the cascade takes
      -- the rejection with it, and the pack returns on the next scan as a fresh
      -- id offering the same candidate the user already turned down.
      OR EXISTS (SELECT 1 FROM orbital_match_rejections r WHERE r.asset_id = assets.id)
    )`;

    const stamped = db
      .prepare(
        `UPDATE assets SET missing_since = COALESCE(missing_since, datetime('now'))
         WHERE ${vanished} AND ${curated} AND missing_since IS NULL`,
      )
      .run(locationId).changes;

    const deleted = db
      .prepare(`DELETE FROM assets WHERE ${vanished} AND NOT ${curated}`)
      .run(locationId).changes;

    return stamped + deleted;
  } finally {
    db.exec('DROP TABLE IF EXISTS _scan_seen');
  }
}

export function toggleFavorite(db: Database, assetIds: number[], isFavorited: boolean): number {
  if (assetIds.length === 0) return 0;
  const placeholders = assetIds.map(() => '?').join(',');
  return db
    .prepare(`UPDATE assets SET is_favorite = ? WHERE id IN (${placeholders})`)
    .run(toSqliteBool(isFavorited), ...assetIds).changes;
}

export function updateAssetDescription(db: Database, id: number, description: string): number {
  return db.prepare('UPDATE assets SET description = ? WHERE id = ?').run(description, id).changes;
}

export interface UserRatingRow {
  asset_id: number;
  rating: number;
}

export function setUserRating(db: Database, assetId: number, rating: number): void {
  const clamped = Math.max(1, Math.min(5, rating));
  const existing = db.prepare('SELECT id FROM asset_notes WHERE asset_id = ?').get(assetId) as
    | { id: number }
    | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`UPDATE asset_notes SET rating = ?, updated_at = ? WHERE asset_id = ?`).run(
      clamped,
      now,
      assetId,
    );
  } else {
    db.prepare(
      `INSERT INTO asset_notes (asset_id, rating, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(assetId, clamped, now, now);
  }
}

export function clearUserRating(db: Database, assetId: number): void {
  db.prepare(`UPDATE asset_notes SET rating = NULL, updated_at = ? WHERE asset_id = ?`).run(
    new Date().toISOString(),
    assetId,
  );
}

export function getUserRating(db: Database, assetId: number): number | null {
  const row = db.prepare('SELECT rating FROM asset_notes WHERE asset_id = ?').get(assetId) as
    | { rating: number | null }
    | undefined;
  return row?.rating ?? null;
}

export interface AssetStats {
  total: number;
  favorites: number;
  with_orbital: number;
  /** Courses — a separate population from packs, never folded into `total`. */
  courses: number;
  fab_owned: number;
  unmatched: number;
  /**
   * Unmatched MINUS what the user dismissed in the Match queue — the real
   * depth of the queue, as opposed to , which is a property of the
   * data and must keep counting dismissed packs.
   */
  needs_review: number;
  /** Bytes on disk across packs only, matching `total`. */
  size_bytes: number;
}

/**
 * One authoritative snapshot of the library.
 *
 * Every field except `courses` and `size_bytes` counts the SAME population:
 * packs, i.e. `content_format IS NULL`. That uniformity is the point. Before
 * this, `total` gated on content_format while `with_orbital` and `fab_owned`
 * did not, so the numbers on one settings tab could not be added up — and
 * `getDatabaseStats.asset_count` counted every row and was also labelled
 * "assets", which is how the app came to show 2,799 and 3,010 for the same
 * noun on the same screen.
 *
 * Courses are a separate population and are named separately. If you need a
 * grand total, it is `total + courses` and it should be shown as two numbers.
 */
export function getAssetStats(db: Database): AssetStats {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const PACKS = 'content_format IS NULL';
  return {
    total: one(`SELECT COUNT(*) AS n FROM assets WHERE ${PACKS}`),
    courses: one('SELECT COUNT(*) AS n FROM assets WHERE content_format IS NOT NULL'),
    favorites: one(`SELECT COUNT(*) AS n FROM assets WHERE is_favorite = 1 AND ${PACKS}`),
    with_orbital: one(
      `SELECT COUNT(*) AS n FROM assets WHERE matched_orbital_product_slug IS NOT NULL AND ${PACKS}`,
    ),
    fab_owned: one(`SELECT COUNT(*) AS n FROM assets WHERE fab_owned = 1 AND ${PACKS}`),
    unmatched: one(
      `SELECT COUNT(*) AS n FROM assets
       WHERE matched_orbital_product_slug IS NULL
         AND id NOT IN (SELECT asset_id FROM asset_marketplace_matches)
         AND ${PACKS}`,
    ),
    needs_review: one(
      `SELECT COUNT(*) AS n FROM assets
       WHERE matched_orbital_product_slug IS NULL
         AND NOT EXISTS (SELECT 1 FROM orbital_match_rejections r
                          WHERE r.asset_id = assets.id AND r.product_slug IS NULL)
         AND ${PACKS}`,
    ),
    size_bytes: one(`SELECT COALESCE(SUM(file_size), 0) AS n FROM assets WHERE ${PACKS}`),
  };
}

export interface DatabaseStats {
  asset_count: number;
  location_count: number;
  collection_count: number;
  tag_count: number;
  size_bytes: number;
}

export function getDatabaseStats(db: Database): DatabaseStats {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    asset_count: one('SELECT COUNT(*) AS n FROM assets'),
    location_count: one('SELECT COUNT(*) AS n FROM scan_locations'),
    collection_count: one('SELECT COUNT(*) AS n FROM collections'),
    tag_count: one('SELECT COUNT(*) AS n FROM asset_tags'),
    size_bytes: one('SELECT COALESCE(SUM(file_size), 0) AS n FROM assets'),
  };
}

// ---------------------------------------------------------------------------

/**
 * Every WHERE clause an asset listing needs, as one reusable pair.
 *
 * Split out of `buildAssetQuery` so FTS search can apply the identical
 * predicates. Two things follow from sharing it. Search now respects the
 * sidebar facets, which is what makes "unmatched Blender props" answerable
 * while a query is typed instead of only when it is cleared. And search stops
 * leaking rows the browse path has always excluded — it had no
 * `content_format`/`missing_since` guard of its own, so a search could return
 * courses and soft-deleted packs that the grid beside it insisted were not
 * assets.
 *
 * Columns are qualified with `assets.` because the search query JOINs
 * `assets_fts`, which exposes the same column names.
 */
function assetFilterClauses(filter: AssetFilter | null): {
  where: string[];
  params: unknown[];
} {
  // Packs only. Courses are a separate population with their own view, and
  // every other count in the app already excludes them — totalCount,
  // favoriteCount, categoryCounts, ecosystemCounts all gate on this same
  // predicate. Without it here the grid listed 3,010 rows while every facet
  // beside it said 2,799, and the 211 courses rendered as asset cards with no
  // thumbnail, no kind and no engine. That was the app disagreeing with itself
  // about what an asset is.
  // Packs only, and only packs still on disk. A soft-deleted row is kept so
  // its curation survives a rename (see pruneAssetsNotIn), but it is not part
  // of the library you can open — listing it unmarked would be a lie, and the
  // collection that references it still shows it via `collections.assets`.
  const where: string[] = ['assets.content_format IS NULL', 'assets.missing_since IS NULL'];
  const params: unknown[] = [];

  if (filter?.asset_type) {
    where.push('assets.asset_type = ?');
    params.push(filter.asset_type);
  }
  if (filter?.is_favorite !== null && filter?.is_favorite !== undefined) {
    where.push('assets.is_favorite = ?');
    params.push(toSqliteBool(filter.is_favorite));
  }
  if (filter?.scan_location_id !== null && filter?.scan_location_id !== undefined) {
    where.push('assets.scan_location_id = ?');
    params.push(filter.scan_location_id);
  }
  if (filter?.name_search) {
    where.push('(assets.name LIKE ? OR assets.orbital_title LIKE ?)');
    const like = `%${filter.name_search}%`;
    params.push(like, like);
  }
  if (filter?.tags && filter.tags.length > 0) {
    // Tags are a JSON string; match as substring per-tag (same approach as
    // src-tauri/src/services/query_builder.rs).
    const tagClauses = filter.tags.map(() => 'assets.tags LIKE ?').join(' AND ');
    where.push(`(${tagClauses})`);
    for (const tag of filter.tags) {
      params.push(`%"${tag}"%`);
    }
  }
  if (filter?.date_range) {
    where.push('assets.created_date >= ? AND assets.created_date <= ?');
    params.push(filter.date_range.start, filter.date_range.end);
  }
  if (filter?.category) {
    // `orbital_categories` is a JSON array of category strings. Use json_each
    // via a correlated subquery to test "any element equals filter value".
    where.push(
      'EXISTS (SELECT 1 FROM json_each(assets.orbital_categories) WHERE json_each.value = ?)',
    );
    params.push(filter.category);
  }
  if (filter?.ecosystem) {
    // The scanner writes both `asset_ecosystem` (newer) and `ecosystem`
    // (legacy) — match either so partial-migration data still filters.
    where.push("COALESCE(assets.asset_ecosystem, assets.ecosystem, 'unknown') = ?");
    params.push(filter.ecosystem);
  }
  if (filter?.match_status === 'orbital') {
    where.push('assets.matched_orbital_product_slug IS NOT NULL');
  } else if (filter?.match_status === 'unmatched') {
    where.push('assets.matched_orbital_product_slug IS NULL');
  } else if (filter?.match_status === 'needs_review') {
    // The Match queue: unmatched, minus what the user has already dismissed.
    //
    // A separate value rather than a tweak to `unmatched`, because the Library
    // sidebar's Unmatched facet maps to that one. A pack the user dismissed is
    // still unmatched DATA — no seller, no rating, no source URL — so hiding it
    // from the facet would misreport library state and break the invariant that
    // Orbital-matched and Unmatched sum to the total. Rejection is a property
    // of the user's queue, not of the row.
    //
    // Only asset-level dismissals (NULL slug) gate membership. Rejecting a
    // single candidate says the listing was wrong, not that the pack is done.
    where.push('assets.matched_orbital_product_slug IS NULL');
    where.push(
      `NOT EXISTS (SELECT 1 FROM orbital_match_rejections r
                    WHERE r.asset_id = assets.id AND r.product_slug IS NULL)`,
    );
  }

  return { where, params };
}

function buildAssetQuery(
  projection: string,
  filter: AssetFilter | null,
  sort: SortOption | null,
  limit: number | null,
  offset: number | null,
): { sql: string; params: unknown[] } {
  const { where, params } = assetFilterClauses(filter);

  let sql = `SELECT ${projection} FROM assets`;
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  if (sort) sql += ` ORDER BY ${SORT_OPTION_SQL[sort]}`;
  if (limit !== null) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  if (offset !== null && offset > 0) {
    sql += ' OFFSET ?';
    params.push(offset);
  }

  return { sql, params };
}

/**
 * Sanitize a free-text query into an FTS5 MATCH expression.
 *
 * FTS5 treats `"`, `(`, `)`, `:` and a few other chars as operators, so
 * user input is wrapped per-token as a quoted phrase with an appended `*`
 * to enable prefix matching (e.g. `car` → `"car"*`).
 */
function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim().replace(/"/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}
