/**
 * Asset usage tracking types. Ported from `src-tauri/src/models/usage.rs`.
 */
export type AccessType =
  | 'view'
  | 'export'
  | 'project_match'
  | 'collection_add'
  | 'tag_add'
  | 'favorite';

export interface AssetUsage {
  id: number | null;
  asset_id: number;
  access_type: string;
  context: string | null;
  accessed_at: string | null;
}

export interface AssetUsageStats {
  asset_id: number;
  total_accesses: number;
  view_count: number;
  export_count: number;
  match_count: number;
  collection_count: number;
  last_accessed: string | null;
  first_accessed: string | null;
}

export interface RecentActivity {
  asset_id: number;
  asset_name: string;
  access_type: string;
  accessed_at: string;
  context: string | null;
}

export interface UsageContext {
  collection_id: number | null;
  project_name: string | null;
  export_path: string | null;
  notes: string | null;
}

export interface LogUsageRequest {
  asset_id: number;
  access_type: AccessType;
  context: UsageContext | null;
}

export interface UsageSummary {
  period_label: string;
  total_views: number;
  total_exports: number;
  unique_assets_accessed: number;
  /** Tuple: [asset_id, name, count] */
  most_accessed_assets: [number, string, number][];
}
