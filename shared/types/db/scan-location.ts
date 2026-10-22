/**
 * Canonical `scan_locations` row shape. Ported from
 * `src-tauri/src/models/scan_location.rs`.
 */
/**
 * What kind of content a scan location holds. Mirrors the `assets.content_format`
 * vocabulary from migration 20260409000000; `null` means regular assets.
 */
export type ContentFormat = 'course' | 'workshop' | 'ebook' | 'reference' | 'bookmark';

export const CONTENT_FORMATS: readonly ContentFormat[] = [
  'course',
  'workshop',
  'ebook',
  'reference',
  'bookmark',
];

export interface ScanLocation {
  id: number | null;
  name: string;
  path: string;
  is_active: boolean;
  last_scan: string | null;
  scan_recursive: boolean;
  file_extensions: string | null;
  created_date: string;
  description: string | null;
  /**
   * Stamped onto every asset this location produces, which is what puts them in
   * the Learn tab instead of the pack library. `null` = regular assets.
   */
  content_format: ContentFormat | null;
}

/**
 * Streaming progress events emitted during `scan` command execution.
 * Mirrors the Rust `ScanProgress` struct for IPC parity with the existing
 * scanning store.
 */
export interface ScanProgress {
  location_id: number;
  location_name: string | null;
  location_path: string | null;
  status: string;
  current_path: string;
  processed_items: number;
  total_items: number;
  completed_successfully: boolean;
  error: string | null;
  current_location_index: number | null;
  total_locations: number | null;
  cumulative_items_processed: number | null;
  error_count: number | null;
  new_assets_count: number | null;
  existing_assets_count: number | null;
}
