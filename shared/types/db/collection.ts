/**
 * Collection types. Ported from `src-tauri/src/models/collection.rs`.
 */
export interface Collection {
  id: number | null;
  name: string;
  description: string | null;
  /** Hex color code for visual distinction, e.g. "#3b82f6". */
  color: string | null;
  icon: string | null;
  is_smart: boolean | null;
  /** JSON filter criteria for smart collections. */
  smart_filter: string | null;
  sort_order: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CollectionItem {
  collection_id: number;
  asset_id: number;
  added_at: string | null;
  sort_order: number | null;
}

export interface CreateCollectionRequest {
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  is_smart: boolean | null;
  smart_filter: string | null;
}

export interface UpdateCollectionRequest {
  id: number;
  name: string | null;
  description: string | null;
  color: string | null;
  icon: string | null;
  is_smart: boolean | null;
  smart_filter: string | null;
  sort_order: number | null;
}

export interface CollectionWithCount extends Collection {
  asset_count: number;
  /** Bytes on disk across members. */
  size_bytes: number;
  /** JSON array of up to 4 member thumbnail paths, newest first, for the cover mosaic. */
  covers: string | null;
}

export interface SmartFilter {
  include_tags: string[] | null;
  exclude_tags: string[] | null;
  asset_types: string[] | null;
  min_rating: number | null;
  scan_location_ids: number[] | null;
  favorites_only: boolean | null;
  added_within_days: number | null;
}
