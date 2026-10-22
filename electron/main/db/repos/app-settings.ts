import type { AppSetting } from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';
import { normalizeRow, normalizeRows } from './row-helpers';

export function listSettings(db: Database): AppSetting[] {
  const rows = db.prepare('SELECT * FROM app_settings ORDER BY key ASC').all() as Record<
    string,
    unknown
  >[];
  return normalizeRows<AppSetting>(rows);
}

export function getSetting(db: Database, key: string): AppSetting | null {
  const row = db.prepare('SELECT * FROM app_settings WHERE key = ?').get(key) as
    | Record<string, unknown>
    | undefined;
  return normalizeRow<AppSetting>(row);
}

export function setSetting(
  db: Database,
  key: string,
  value: string,
  settingType: string,
  description: string | null = null,
): void {
  const now = new Date().toISOString();
  const existing = getSetting(db, key);
  if (existing) {
    db.prepare(
      'UPDATE app_settings SET value = ?, setting_type = ?, description = ?, modified_date = ? WHERE key = ?',
    ).run(value, settingType, description, now, key);
  } else {
    db.prepare(
      `INSERT INTO app_settings (
        key, value, setting_type, description, created_date, modified_date
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(key, value, settingType, description, now, now);
  }
}

/**
 * Read a boolean setting. Only the exact strings `'true'` and `'false'` count;
 * anything else (absent row, hand-edited value, an old `'1'`) yields `fallback`,
 * so a garbled value can never flip a privacy-relevant switch on.
 */
export function getBooleanSetting(db: Database, key: string, fallback: boolean): boolean {
  const value = getSetting(db, key)?.value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function setBooleanSetting(
  db: Database,
  key: string,
  value: boolean,
  description: string | null = null,
): void {
  setSetting(db, key, value ? 'true' : 'false', 'boolean', description);
}

export function deleteSetting(db: Database, key: string): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}
