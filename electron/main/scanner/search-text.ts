import type { Database } from 'better-sqlite3';

/**
 * Words for the `scan_search_text` FTS column, so a name the tokenizer reads as one
 * token can still be found by the words inside it.
 *
 * FTS5's `unicode61` tokenizer splits on spaces and punctuation but not on case changes,
 * so `ModularSciFiCorridor` is a single token and a search for "corridor" cannot find it.
 * This splits camelCase and acronyms (`UIKit` → `UI Kit`) and also keeps each pair of
 * neighbouring pieces joined (`SciFi`), because a pack named `ModularSciFiCorridor` should
 * still come up for "scifi".
 */
export function buildSearchText(parts: Array<string | null | undefined>): string {
  const words = parts
    .filter(Boolean)
    .join(' ')
    .replaceAll(/[_./@-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    const pieces = word
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ');
    out.push(...pieces);
    for (let i = 0; i < pieces.length - 1; i++) out.push(pieces[i] + pieces[i + 1]);
  }
  return out.join(' ');
}

/**
 * One-off fill of `scan_search_text` for rows the pack scanner wrote before it set that
 * column, so existing libraries get split names without waiting for a rescan.
 *
 * Touches only rows where the column is still NULL and that DCC and Unity scans do not
 * own (those write their own text). Each row is written once: afterwards the column is
 * non-NULL, even if only '', so later launches select nothing. Returns rows updated.
 */
export function backfillPackSearchText(db: Pick<Database, 'prepare' | 'exec'>): number {
  const rows = db
    .prepare(
      `SELECT id, name FROM assets
       WHERE scan_search_text IS NULL
         AND asset_type NOT GLOB 'dcc_*' AND asset_type NOT GLOB 'unity_*'`,
    )
    .all() as { id: number; name: string }[];
  if (rows.length === 0) return 0;
  const update = db.prepare('UPDATE assets SET scan_search_text = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of rows) update.run(buildSearchText([row.name]), row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}
