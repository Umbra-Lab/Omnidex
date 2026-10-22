/**
 * Normalized-schema marketplace types. Ported from
 * `src-tauri/src/models/marketplace.rs`.
 */

export type Marketplace = 'orbital' | 'fab' | 'epic';

export interface MarketplaceMatch {
  id: number;
  asset_id: number;
  marketplace: string;
  product_slug: string | null;
  fab_id: string | null;
  match_confidence: number;
  match_source: string | null;
  verified: boolean;
  manual_overrides: string | null;
  matched_at: string;
  last_verified_at: string | null;
}

export interface OrbitalMetadata {
  id: number;
  match_id: number;
  title: string | null;
  description: string | null;
  technical_details: string | null;
  seller_name: string | null;
  price: number | null;
  currency: string | null;
  thumbnail_url: string | null;
  source_url: string | null;
  gallery_images: string | null;
  rating_average: number | null;
  rating_count: number | null;
  categories: string | null;
  supported_versions: string | null;
  release_date: string | null;
  last_modified: string | null;
  fetched_at: string;
  last_checked_timestamp: string | null;
  raw_json: string | null;
}

export interface FabMetadata {
  id: number;
  match_id: number;
  title: string | null;
  description: string | null;
  owner_name: string | null;
  price: number | null;
  currency: string | null;
  thumbnail_url: string | null;
  product_url: string | null;
  fetched_at: string;
  raw_json: string | null;
}
