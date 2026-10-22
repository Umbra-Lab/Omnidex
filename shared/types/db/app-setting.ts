/**
 * App settings row shape. Ported from `src-tauri/src/models/app_setting.rs`.
 */
export type SettingType = 'string' | 'number' | 'boolean' | 'json';

export interface AppSetting {
  id: number | null;
  key: string;
  value: string;
  setting_type: string;
  description: string | null;
  created_date: string;
  modified_date: string;
}

export interface AppSettings {
  theme: string;
  auto_scan: boolean;
  scan_interval_minutes: number;
  thumbnail_size: string;
  show_hidden_files: boolean;
  default_view: string;
  backup_enabled: boolean;
  backup_location: string | null;
}
