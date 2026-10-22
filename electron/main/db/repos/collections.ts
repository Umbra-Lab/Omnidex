import type {
  AssetCardData,
  Collection,
  CollectionWithCount,
  CreateCollectionRequest,
} from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';
import { normalizeRow, normalizeRows, toSqliteBool } from './row-helpers';

// Mirror of the card projection in repos/assets.ts so collection detail grids
// render the same AssetCardShape the asset grid does.
const CARD_COLUMNS = `
  a.id, a.name, a.orbital_title, a.asset_type, a.file_size, a.file_path,
  a.thumbnail_path, a.orbital_thumbnail_url,
  a.orbital_rating_average, a.orbital_rating_count,
  a.orbital_price, a.orbital_source_url, a.orbital_seller_name,
  a.is_favorite, a.created_date, a.fab_owned,
  a.tags, a.orbital_categories,
  a.asset_ecosystem, a.ecosystem, a.orbital_supported_versions,
  a.scan_location_id, a.matched_orbital_product_slug, a.missing_since
`;

/**
 * Collections with everything the card needs to be more than a name and a
 * number: total size, and up to four member thumbnails for a cover mosaic.
 *
 * A collection is a curated set of visual content and its card showed no
 * pixels at all. `covers` is JSON so the whole list stays one query — a
 * per-card cover fetch would be N+1 on a screen that exists to be glanced at.
 */
export function listCollections(db: Database): CollectionWithCount[] {
  const rows = db
    .prepare(
      `SELECT c.*,
         COALESCE((
           SELECT COUNT(*) FROM collection_items WHERE collection_id = c.id
         ), 0) AS asset_count,
         COALESCE((
           SELECT SUM(a.file_size)
           FROM collection_items ci
           JOIN assets a ON a.id = ci.asset_id
           WHERE ci.collection_id = c.id
         ), 0) AS size_bytes,
         (
           SELECT json_group_array(cover) FROM (
             SELECT COALESCE(a.thumbnail_path, a.orbital_thumbnail_url) AS cover
             FROM collection_items ci
             JOIN assets a ON a.id = ci.asset_id
             WHERE ci.collection_id = c.id
               AND COALESCE(a.thumbnail_path, a.orbital_thumbnail_url) IS NOT NULL
             ORDER BY ci.added_at DESC
             LIMIT 4
           )
         ) AS covers
       FROM collections c
       ORDER BY COALESCE(c.sort_order, 999), c.name ASC`,
    )
    .all() as Record<string, unknown>[];
  return normalizeRows<CollectionWithCount>(rows);
}

export function getCollection(db: Database, id: number): Collection | null {
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return normalizeRow<Collection>(row);
}

/**
 * Member assets of a collection, projected as cards. Newest-added first
 * (collection_items.added_at DESC) so a freshly-added asset surfaces at the
 * top of the detail grid.
 */
export function listCollectionAssetCards(db: Database, collectionId: number): AssetCardData[] {
  const rows = db
    .prepare(
      `SELECT ${CARD_COLUMNS}
       FROM collection_items ci
       JOIN assets a ON a.id = ci.asset_id
       WHERE ci.collection_id = ?
       ORDER BY ci.added_at DESC, a.name ASC`,
    )
    .all(collectionId) as Record<string, unknown>[];
  return normalizeRows<AssetCardData>(rows);
}

export function createCollection(db: Database, req: CreateCollectionRequest): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO collections (
      name, description, color, icon, is_smart, smart_filter, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(
    req.name,
    req.description,
    req.color,
    req.icon,
    toSqliteBool(req.is_smart),
    req.smart_filter,
    now,
    now,
  );
  return Number(result.lastInsertRowid);
}

export function deleteCollection(db: Database, id: number): void {
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
}

export function addAssetsToCollection(
  db: Database,
  collectionId: number,
  assetIds: number[],
): void {
  if (assetIds.length === 0) return;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO collection_items (collection_id, asset_id, added_at) VALUES (?, ?, ?)',
  );
  const now = new Date().toISOString();
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) stmt.run(collectionId, id, now);
  });
  tx(assetIds);
}

export function removeAssetsFromCollection(
  db: Database,
  collectionId: number,
  assetIds: number[],
): void {
  if (assetIds.length === 0) return;
  const placeholders = assetIds.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM collection_items WHERE collection_id = ? AND asset_id IN (${placeholders})`,
  ).run(collectionId, ...assetIds);
}
