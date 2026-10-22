/**
 * Frontend-flavored asset details used by the inspector panel.
 * Ported from `src-tauri/src/models/asset_details.rs` (the AssetForFrontend
 * projection). Kept minimal — expand only when the Electron port of the
 * inspector requires new fields.
 */
export interface AssetForFrontend {
  id: number;
  name: string;
  thumbnail_url: string | null;
  creator_name: string | null;
  rating: number | null;
  reviews_count: number | null;
  description: string | null;
  tags: string[];
  scraped_tags: string[];
  file_path: string;
  file_size: number;
  date_created: string;
  engine_version: string | null;
  is_matched: boolean;
  folder_name: string | null;
  scan_location_id: number | null;
}
