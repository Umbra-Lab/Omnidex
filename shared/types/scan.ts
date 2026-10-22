// Scan-related TypeScript types for Omnidex (Svelte version)
// These types support the scan queue system and error recovery flows

export interface ScanLocation {
  id: number;
  name: string;
  path: string;
  is_active: boolean;
  scan_recursive?: boolean;
  file_extensions?: string | null;
  last_scan?: string | null; // Backend field name (matches Rust model)
  asset_count?: number;
  description?: string | null;
  created_date?: string;

  // Extended properties (computed)
  assetCount?: number;
  errorStatus?: ScanError | null;
}

export interface ScanQueueItem {
  id: string; // UUID
  locationId: number;
  locationName: string;
  status: 'queued' | 'active' | 'completed' | 'cancelled' | 'failed';
  progress: number; // 0-100
  totalItems: number;
  processedItems: number;
  currentPath: string;
  startedAt: Date | null;
  completedAt: Date | null;
  error: ScanError | null;
  estimatedTimeRemaining: number | null; // seconds
}

export interface ScanError {
  type: 'permission_denied' | 'path_not_found' | 'network_timeout' | 'disk_full' | 'unknown';
  message: string;
  details: string[];
  affectedFiles: string[];
  timestamp: Date;
  recoveryActions: RecoveryAction[];
}

export interface RecoveryAction {
  label: string;
  action: 'retry' | 'edit_location' | 'exclude_folder' | 'run_as_admin' | 'check_permissions';
  icon: string;
}

export type LocationFilter = 'all' | 'active' | 'inactive' | 'never_scanned' | 'has_errors';
export type LocationSort = 'name' | 'last_scan' | 'asset_count' | 'error_status';

export interface LocationListState {
  searchQuery: string;
  activeFilter: LocationFilter;
  sortBy: LocationSort;
  selectedIds: Set<number>;
}

// Backend event types (snake_case only — matches Rust ScanProgress serde output)
export interface ScanProgress {
  location_id: number;
  location_name?: string;
  location_path?: string;
  status:
    | 'Initializing'
    | 'Starting'
    | 'Scanning'
    | 'Completed'
    | 'AllCompleted'
    | 'Error'
    | 'Cancelled';
  total_items: number;
  processed_items: number;
  current_path: string;
  completed_successfully?: boolean;
  error?: string | null;
  // Multi-location scan progress
  current_location_index?: number;
  total_locations?: number;
  cumulative_items_processed?: number;
  error_count?: number;
  // New/existing asset counts for completion toast
  new_assets_count?: number;
  existing_assets_count?: number;
}

export interface ScanProgressWithId extends ScanProgress {
  queue_id: string;
  progress: number; // 0-100
  estimated_time_remaining: number | null;
}
