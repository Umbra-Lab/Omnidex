/**
 * Minimal asset shape for list/grid rendering. Ported from
 * `src-tauri/src/models/asset_card.rs`.
 */
export interface AssetCardData {
  id: number;
  name: string;
  orbital_title: string | null;
  asset_type: string;
  file_size: number;
  file_path: string | null;
  thumbnail_path: string | null;
  orbital_thumbnail_url: string | null;
  orbital_rating_average: number | null;
  orbital_rating_count: number | null;
  orbital_price: number | null;
  orbital_source_url: string | null;
  orbital_seller_name: string | null;
  is_favorite: boolean;
  created_date: string;
  fab_owned: boolean;
  // JSON-stringified arrays. `tags` carries FAB-derived slugs ("weapons",
  // "animations") set during the FAB enrichment job; `orbital_categories`
  // carries marketplace categories from Orbital. The card-pill prefers
  // these over `asset_type` because "Weapons" is more useful than
  // "unreal_pack".
  tags: string | null;
  orbital_categories: string | null;
  // Added for the table view. The grid card does not use most of these, but
  // both views read one projection — a second query shape would guarantee the
  // two disagree about what a row is.
  asset_ecosystem: string | null;
  ecosystem: string | null;
  orbital_supported_versions: string | null;
  scan_location_id: number | null;
  matched_orbital_product_slug: string | null;
  /** Set when a scan stopped finding this path. The row is kept because it
   *  carries curation; it is not part of the on-disk library. */
  missing_since: string | null;
}

/**
 * Sort keys understood by the repo layer. Values match the `serde(rename_all
 * = "snake_case")` encoding of the Rust enum so legacy IPC payloads deserialize
 * without translation.
 */
export type SortOption =
  | 'name_asc'
  | 'name_desc'
  | 'date_asc'
  | 'date_desc'
  | 'date_added_asc'
  | 'date_added_desc'
  | 'rating_desc'
  | 'rating_asc'
  | 'reviews_desc'
  | 'price_desc'
  | 'price_asc'
  | 'size_desc'
  | 'size_asc'
  | 'favorites_first';

export const SORT_OPTION_SQL: Record<SortOption, string> = {
  name_asc: 'name ASC',
  name_desc: 'name DESC',
  date_asc: 'modified_date ASC',
  date_desc: 'modified_date DESC',
  date_added_asc: 'created_date ASC',
  date_added_desc: 'created_date DESC',
  rating_desc: 'COALESCE(orbital_rating_average, 0) DESC, name ASC',
  rating_asc:
    'CASE WHEN orbital_rating_average IS NULL THEN 1 ELSE 0 END, orbital_rating_average ASC, name ASC',
  reviews_desc: 'COALESCE(orbital_rating_count, 0) DESC, name ASC',
  price_desc: 'COALESCE(orbital_price, 0) DESC, name ASC',
  price_asc:
    'CASE WHEN orbital_price IS NULL OR orbital_price = 0 THEN 1 ELSE 0 END, orbital_price ASC, name ASC',
  size_desc: 'file_size DESC, name ASC',
  size_asc: 'file_size ASC, name ASC',
  favorites_first: 'is_favorite DESC, name ASC',
};

export const DEFAULT_SORT: SortOption = 'date_desc';
