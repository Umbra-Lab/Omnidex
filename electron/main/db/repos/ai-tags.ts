import type { Database } from 'better-sqlite3';

/**
 * Storage for the enrich-tags job: search keywords Claude wrote for a pack.
 *
 * `ai_tags` is its own column (and its own `assets_fts` column, ranked below the
 * user's tags) so the user's tags are never touched and a bad run can be undone with
 * `clearAiTags`. NULL means never tagged; '' means tagged with nothing to add.
 */

/** What the model is shown about one pack. Only fields a scan or a marketplace match filled. */
export interface TaggablePack {
  id: number;
  name: string;
  asset_type: string;
  display_title: string | null;
  orbital_title: string | null;
  orbital_seller_name: string | null;
  orbital_categories: string | null;
  description: string | null;
  orbital_description: string | null;
  scan_search_text: string | null;
}

/**
 * Packs with no AI tags yet, the most-rated first (they are the ones searched for),
 * then the largest. Courses, files from the DCC index, packs missing from disk and
 * Unity folders that are not packages are left out: the tags describe packs.
 */
export function untaggedPacks(db: Database, limit: number): TaggablePack[] {
  return db
    .prepare(
      `SELECT id, name, asset_type, display_title, orbital_title, orbital_seller_name,
              orbital_categories, description, orbital_description, scan_search_text
       FROM assets
       WHERE ai_tags IS NULL
         AND content_format IS NULL AND missing_since IS NULL
         AND asset_type NOT GLOB 'dcc_*' AND asset_type <> 'unity_project'
         AND (asset_type NOT GLOB 'unity_*' OR asset_type = 'unity_package')
       ORDER BY COALESCE(orbital_rating_count, 0) DESC, file_size DESC, id ASC
       LIMIT ?`,
    )
    .all(limit) as TaggablePack[];
}

/** Count of packs `untaggedPacks` would still return, for progress. */
export function countUntagged(db: Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM assets
       WHERE ai_tags IS NULL
         AND content_format IS NULL AND missing_since IS NULL
         AND asset_type NOT GLOB 'dcc_*' AND asset_type <> 'unity_project'
         AND (asset_type NOT GLOB 'unity_*' OR asset_type = 'unity_package')`,
    )
    .get() as { n: number };
  return row.n;
}

/** Store one pack's tags (comma-separated). The FTS trigger re-indexes the row. */
export function setAiTags(db: Database, id: number, tags: readonly string[]): void {
  db.prepare('UPDATE assets SET ai_tags = ?, ai_tagged_at = ? WHERE id = ?').run(
    tags.join(', '),
    new Date().toISOString(),
    id,
  );
}

/** Forget every AI tag, so the next run writes them again. Returns rows cleared. */
export function clearAiTags(db: Database): number {
  const info = db
    .prepare('UPDATE assets SET ai_tags = NULL, ai_tagged_at = NULL WHERE ai_tags IS NOT NULL')
    .run();
  return Number(info.changes);
}
