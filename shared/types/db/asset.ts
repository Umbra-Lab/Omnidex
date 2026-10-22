/**
 * Canonical TypeScript representation of the `assets` table.
 *
 * Ported from `src-tauri/src/models/asset.rs`. After Phase 4 of the migration,
 * this file is the single source of truth for asset shape — the Rust struct
 * retires along with the rest of the Tauri backend.
 *
 * Field naming is snake_case to match SQLite columns and legacy IPC payloads.
 * Nullable columns surface as `| null` (not `?`) so `JSON.stringify` round-trips
 * between main and renderer without ambiguity.
 */
export interface Asset {
  id: number | null;
  name: string;
  file_path: string;
  asset_type: string;
  file_size: number;
  /**
   * True when the scanner's per-pack walk hit its file/depth cap, making
   * `file_size` a lower bound. Render as "26.7 GB+", never as an exact size.
   */
  file_size_is_partial: boolean;
  created_date: string;
  modified_date: string;
  first_indexed_timestamp: string | null;
  thumbnail_path: string | null;
  has_local_thumbnail: boolean | null;
  tags: string | null;
  description: string | null;
  scan_location_id: number;
  is_favorite: boolean;
  last_accessed: string | null;
  file_hash: string | null;
  metadata: string | null;

  orbital_title: string | null;
  orbital_description: string | null;
  orbital_technical_details: string | null;
  orbital_seller_name: string | null;
  orbital_price: number | null;
  orbital_release_date: string | null;
  orbital_last_modified: string | null;
  orbital_rating_average: number | null;
  orbital_rating_count: number | null;
  orbital_categories: string | null;
  orbital_supported_versions: string | null;
  orbital_gallery_images: string | null;
  orbital_thumbnail_url: string | null;
  orbital_source_url: string | null;
  orbital_raw_json: string | null;
  orbital_last_checked_timestamp: string | null;

  matched_orbital_product_slug: string | null;
  /** FAB Marketplace UUID. Persisted as `fab_item_id` but serialized as `orbital_fab_id`. */
  orbital_fab_id: string | null;
  orbital_match_confidence: number | null;
  orbital_match_type: string | null;

  notes: string | null;
  orbital_manual_overrides: string | null;

  content_format: string | null;
  completion_status: string | null;
  tutorial_source: string | null;

  fab_owned: boolean;
  asset_ecosystem: string | null;
  orbital_match_attempted: boolean | null;
}

export interface DateRange {
  start: string;
  end: string;
}

export interface AssetFilter {
  asset_type: string | null;
  tags: string[] | null;
  name_search: string | null;
  is_favorite: boolean | null;
  scan_location_id: number | null;
  date_range: DateRange | null;
  // Below are post-Tauri additions for the React sidebar. `category` matches
  // any element of the `orbital_categories` JSON array; `ecosystem` matches
  // `asset_ecosystem`/`ecosystem` column. Both optional/null = no filter.
  category?: string | null;
  ecosystem?: string | null;
  // Marketplace-match status: `orbital` = has a resolved orbital match,
  // `unmatched` = none. Drives the sidebar's Marketplace facets. null = no filter.
  match_status?: 'orbital' | 'unmatched' | 'needs_review' | null;
}

export interface AssetTypeCount {
  asset_type: string;
  count: number;
}

export interface AssetStats {
  total_assets: number;
  total_size: number;
  asset_type_counts: AssetTypeCount[];
  recent_assets: Asset[];
}
