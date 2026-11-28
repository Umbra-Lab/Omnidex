import type { Database } from 'better-sqlite3';
import { escapeLike } from './row-helpers';

/**
 * Tag operations. Mirrors `src-tauri/src/commands/tag_commands.rs` subset.
 *
 * Schema: `asset_tags (id, asset_id, tag, tag_type, confidence, source, created_at)`
 *
 * - `tag_type` ∈ { genre, mechanics, art_style, technical, use_case }
 * - `source` ∈ { ai, official, user }
 */

export interface TagRecord {
  id: number;
  asset_id: number;
  tag: string;
  tag_type: string;
  confidence: number | null;
  source: string;
  created_at: string;
}

export function getAssetTags(db: Database, assetId: number): TagRecord[] {
  return db
    .prepare('SELECT * FROM asset_tags WHERE asset_id = ? ORDER BY created_at DESC')
    .all(assetId) as TagRecord[];
}

export function addTag(
  db: Database,
  assetId: number,
  tag: string,
  opts: { tagType?: string; source?: string; confidence?: number | null } = {},
): boolean {
  const { tagType = 'technical', source = 'user', confidence = null } = opts;
  try {
    db.prepare(
      `INSERT INTO asset_tags (asset_id, tag, tag_type, confidence, source)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(assetId, tag, tagType, confidence, source);
    return true;
  } catch {
    return false;
  }
}

export function removeTag(db: Database, assetId: number, tag: string): number {
  return db.prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag = ?').run(assetId, tag)
    .changes;
}

/**
 * Returns a function that rewrites one asset's `assets.tags` JSON mirror from
 * its `asset_tags` rows (every source), de-duplicated and sorted by tag.
 *
 * Sorted so the same tags always give the same JSON: a FAB re-sync that
 * re-creates the same category rows leaves the mirror as it was, and the write
 * is skipped, so the FTS trigger does not reindex the row again.
 *
 * `asset_tags` is the store; `assets.tags` is only a mirror that the FTS index
 * (via the `assets_fts_au` trigger), the `tags LIKE '%"tag"%'` filter in
 * `assets.ts` and the card's `firstFromJsonArray` read. Anything that changes
 * tags writes rows and then calls this, so the two can never disagree. The
 * mirror is a plain `string[]`, or `NULL` when the asset has no tags.
 */
export function tagMirrorWriter(db: Database): (assetId: number) => void {
  const selectAll = db.prepare(
    'SELECT tag FROM asset_tags WHERE asset_id = ? GROUP BY tag ORDER BY tag',
  );
  // `IS NOT` skips an unchanged mirror, so `assets_fts_au` only fires on a change.
  const updateAssets = db.prepare('UPDATE assets SET tags = ? WHERE id = ? AND tags IS NOT ?');
  return (assetId) => {
    const merged = (selectAll.all(assetId) as { tag: string }[]).map((r) => r.tag);
    const json = merged.length > 0 ? JSON.stringify(merged) : null;
    updateAssets.run(json, assetId, json);
  };
}

/**
 * Make `tags` the asset's whole tag set, whatever source each tag came from.
 *
 * The tagging modal shows every tag on the asset (user, AI and FAB category
 * tags alike, see `assets.getTags`) and saves the list it shows. So a tag
 * missing from the list is one the person removed, and its row goes, whatever
 * its source. Earlier this only swapped `source = 'user'` rows: removing an AI
 * or FAB tag in the modal did nothing, and it came straight back.
 *
 * A tag that already has a row keeps it (and its source); a new one is added
 * as a user tag. A FAB category tag removed here comes back on the next FAB
 * sync, because the sync re-applies the listing's categories.
 *
 * One transaction, so the rows and the mirror never drift apart. `tag_type` is
 * `'technical'`, a value the `asset_tags` CHECK constraint allows (it does not
 * allow `'user'`).
 */
export function setAssetTags(db: Database, assetId: number, tags: string[]): void {
  const cleaned = Array.from(new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)));
  const deleteRemoved = db.prepare(
    'DELETE FROM asset_tags WHERE asset_id = ? AND tag NOT IN (SELECT value FROM json_each(?))',
  );
  const insertNew = db.prepare(
    `INSERT INTO asset_tags (asset_id, tag, tag_type, confidence, source)
     SELECT ?, ?, 'technical', NULL, 'user'
     WHERE NOT EXISTS (SELECT 1 FROM asset_tags WHERE asset_id = ? AND tag = ?)`,
  );
  const writeMirror = tagMirrorWriter(db);

  const tx = db.transaction(() => {
    deleteRemoved.run(assetId, JSON.stringify(cleaned));
    for (const tag of cleaned) insertNew.run(assetId, tag, assetId, tag);
    writeMirror(assetId);
  });
  tx();
}

/**
 * Replace an asset's FAB category tags (`source = 'official'`) with `tags`, and
 * rewrite the mirror. User and AI tags are left alone.
 *
 * The FAB sync used to write its category slugs straight into `assets.tags`,
 * which dropped the person's own tags from search, the tag filter and the card
 * (their rows were still there), and the next tag edit rebuilt the mirror from
 * the rows and dropped the FAB tags instead. An empty `tags` leaves the
 * existing official tags as they are, as the sync's old `COALESCE` did.
 *
 * The caller runs this inside its own transaction.
 */
export function officialTagsWriter(
  db: Database,
): (assetId: number, tags: readonly string[]) => void {
  const deleteOfficial = db.prepare(
    "DELETE FROM asset_tags WHERE asset_id = ? AND source = 'official'",
  );
  const insertOfficial = db.prepare(
    `INSERT OR IGNORE INTO asset_tags (asset_id, tag, tag_type, confidence, source)
     VALUES (?, ?, 'technical', NULL, 'official')`,
  );
  const writeMirror = tagMirrorWriter(db);
  return (assetId, tags) => {
    if (tags.length === 0) return;
    deleteOfficial.run(assetId);
    for (const tag of tags) insertOfficial.run(assetId, tag);
    writeMirror(assetId);
  };
}

/**
 * Add tags to many assets at once, leaving each asset's existing tags alone.
 *
 * ADD, deliberately, not the plural form of `setAssetTags`. Select forty packs,
 * type "wip", save — a replace would silently delete every existing user tag on
 * all forty, from the same gesture as the benign case, with no undo anywhere in
 * the app and no visible before-state to compare against. Someone typing one
 * word over a selection means "give all of these a wip tag", never "make wip
 * the only tag on all of these".
 *
 * It is also the only coherent choice for a mixed selection: there is no
 * meaningful "current value" to seed an editor with — a union over-claims, an
 * intersection under-claims, and empty implies you are about to erase. That
 * ambiguity is why the bulk control was deferred, and it dissolves once the
 * operation is a delta rather than an edit.
 *
 * Adding is idempotent, so a double-click is harmless and a mistake is undone
 * by removing the one tag you named.
 *
 * One transaction across every asset: a partial application would leave the
 * selection in a state the user cannot see or reason about.
 */
export function addAssetTags(db: Database, assetIds: number[], tags: string[]): number {
  const cleaned = Array.from(new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)));
  if (cleaned.length === 0 || assetIds.length === 0) return 0;

  const insertUser = db.prepare(
    `INSERT OR IGNORE INTO asset_tags (asset_id, tag, tag_type, confidence, source)
     VALUES (?, ?, 'technical', NULL, 'user')`,
  );
  // Re-writing the JSON mirror is what fires `assets_fts_au`, so search and the
  // tag filter see the change with no extra work — same contract as setAssetTags.
  const writeMirror = tagMirrorWriter(db);

  const tx = db.transaction(() => {
    for (const assetId of assetIds) {
      for (const tag of cleaned) insertUser.run(assetId, tag);
      writeMirror(assetId);
    }
  });
  tx();
  return assetIds.length;
}

export interface BulkTagResult {
  assets_affected: number;
  tags_added: number;
}

export function bulkAddTags(
  db: Database,
  assetIds: number[],
  tags: string[],
  opts: { tagType?: string; source?: string; confidence?: number | null } = {},
): BulkTagResult {
  const { tagType = 'user', source = 'user', confidence = null } = opts;
  if (assetIds.length === 0 || tags.length === 0) {
    return { assets_affected: 0, tags_added: 0 };
  }
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO asset_tags (asset_id, tag, tag_type, confidence, source)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let added = 0;
  const tx = db.transaction(() => {
    for (const id of assetIds) {
      for (const tag of tags) {
        const res = stmt.run(id, tag, tagType, confidence, source);
        added += res.changes;
      }
    }
  });
  tx();
  return { assets_affected: assetIds.length, tags_added: added };
}

export interface TagSuggestion {
  tag: string;
  count: number;
  tag_type: string;
}

export function searchTags(db: Database, query: string, limit = 20): TagSuggestion[] {
  const like = `%${escapeLike(query.toLowerCase())}%`;
  return db
    .prepare(
      `SELECT tag, COUNT(*) AS count, tag_type
       FROM asset_tags
       WHERE LOWER(tag) LIKE ? ESCAPE '\\'
       GROUP BY tag, tag_type
       ORDER BY count DESC
       LIMIT ?`,
    )
    .all(like, limit) as TagSuggestion[];
}

export function countUntagged(db: Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM assets a
       WHERE NOT EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id)
         AND a.content_format IS NULL`,
    )
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface TagGroup {
  canonical: string;
  variants: string[];
  usage: number;
}

/**
 * Find tags that look like near-duplicates — e.g. "sci-fi" vs "scifi".
 * Naive grouping by alphanumeric-lowercase collapse.
 */
export function findSimilarTags(db: Database, threshold = 0.85): TagGroup[] {
  void threshold;
  const rows = db.prepare('SELECT tag, COUNT(*) AS n FROM asset_tags GROUP BY tag').all() as {
    tag: string;
    n: number;
  }[];

  const groups = new Map<string, { variants: Map<string, number>; total: number }>();
  for (const r of rows) {
    const key = r.tag.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) continue;
    const g = groups.get(key) ?? { variants: new Map(), total: 0 };
    g.variants.set(r.tag, r.n);
    g.total += r.n;
    groups.set(key, g);
  }

  return Array.from(groups.values())
    .filter((g) => g.variants.size > 1)
    .map((g) => {
      const ordered = Array.from(g.variants.entries()).sort((a, b) => b[1] - a[1]);
      return {
        canonical: ordered[0][0],
        variants: ordered.map(([tag]) => tag),
        usage: g.total,
      };
    })
    .sort((a, b) => b.usage - a.usage);
}

export interface MergeResult {
  merged_count: number;
  assets_affected: number;
}

export function mergeTags(db: Database, fromTags: string[], toTag: string): MergeResult {
  if (fromTags.length === 0) return { merged_count: 0, assets_affected: 0 };
  let affected = 0;
  const tx = db.transaction(() => {
    for (const from of fromTags) {
      if (from === toTag) continue;
      const res = db
        .prepare(`UPDATE OR IGNORE asset_tags SET tag = ? WHERE tag = ?`)
        .run(toTag, from);
      affected += res.changes;
      // Remove any collisions left behind by UPDATE OR IGNORE.
      db.prepare('DELETE FROM asset_tags WHERE tag = ?').run(from);
    }
  });
  tx();
  return { merged_count: fromTags.length, assets_affected: affected };
}
