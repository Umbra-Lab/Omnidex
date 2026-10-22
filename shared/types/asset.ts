// Re-export Asset type from index.ts for compatibility
export type { Asset } from './index';

export interface AssetDetails {
  id: number;
  name: string;
  thumbnail_url?: string;
  creator_name?: string;
  rating?: number;
  reviews_count?: number;
  description?: string;
  tags: string[];
  scraped_tags: string[];
  file_path: string;
  file_size: number;
  date_created: string;
  engine_version?: string;
  is_matched: boolean;
  folder_name?: string; // For unmatched assets
  scan_location_id?: number;
}

export interface AssetCardData {
  id: number;
  name: string;
  orbital_title?: string; // Marketplace name (preferred over folder name)
  asset_type: string;
  file_size: number;
  file_path?: string; // For context menu "Open File Location"
  thumbnail_path?: string;
  orbital_thumbnail_url?: string;
  orbital_rating_average?: number;
  orbital_rating_count?: number;
  orbital_price?: number;
  orbital_source_url?: string; // For context menu "View on Marketplace"
  is_favorite: boolean;
  created_date: string;
  scan_location_id?: number;
  /** True when the asset matches a listing the user owns on FAB. */
  fab_owned?: boolean;
}

export enum SortOption {
  NameAsc = 'name_asc',
  NameDesc = 'name_desc',
  DateAsc = 'date_asc',
  DateDesc = 'date_desc',
  DateAddedAsc = 'date_added_asc',
  DateAddedDesc = 'date_added_desc',
}
