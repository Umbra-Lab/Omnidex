/**
 * SQLite stores booleans as INTEGER 0/1. better-sqlite3 returns them verbatim
 * as numbers, which breaks downstream code that expects `true`/`false`. These
 * helpers normalize rows at the repo boundary so the IPC surface always emits
 * real booleans matching the TS type definitions.
 */

const BOOLEAN_COLUMNS = new Set([
  'is_favorite',
  'is_active',
  'scan_recursive',
  'has_local_thumbnail',
  'fab_owned',
  'is_smart',
  'completed_successfully',
  'verified',
  'orbital_match_attempted',
  'file_size_is_partial',
]);

/**
 * Normalize a single row read from SQLite:
 *   - Converts INTEGER 0/1 to boolean for known boolean columns.
 *   - Preserves nulls verbatim (so `| null` types round-trip correctly).
 */
export function normalizeRow<T>(row: Record<string, unknown> | undefined): T | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (BOOLEAN_COLUMNS.has(key) && (value === 0 || value === 1)) {
      out[key] = value === 1;
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export function normalizeRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => normalizeRow<T>(row)).filter((row): row is T => row !== null);
}

export function toSqliteBool(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}
