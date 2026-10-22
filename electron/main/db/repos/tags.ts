import type { Database } from 'better-sqlite3';

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
 * Replace the full user-tag set for one asset AND re-serialize `assets.tags`.
 *
 * AI/official rows are preserved — only `source = 'user'` rows are swapped out —
 * so machine-generated tags stay searchable. The serialized `assets.tags` JSON
 * is the union of every remaining `asset_tags.tag` for the asset, written as a
 * plain `string[]` (`["a","b"]`) so it matches both the FTS index and the
 * `tags LIKE '%"tag"%'` filter in `assets.ts`, and the card's
 * `firstFromJsonArray` reader. `tags` is set to `NULL` when the union is empty.
 *
 * The `UPDATE assets SET tags = ?` fires the `assets_fts_au` trigger, so the
 * FTS index and the tag filter both see the new tags with no extra work. The
 * whole thing runs in one transaction so `asset_tags` rows and the JSON column
 * can never drift apart. `tag_type` is `'technical'` — a value permitted by the
 * `asset_tags` CHECK constraint (which does not allow `'user'`).
 */
export function setAssetTags(db: Database, assetId: number, tags: string[]): void {
  const cleaned = Array.from(new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)));
  const deleteUser = db.prepare(`DELETE FROM asset_tags WHERE asset_id = ? AND source = 'user'`);
  const insertUser = db.prepare(
    `INSERT OR IGNORE INTO asset_tags (asset_id, tag, tag_type, confidence, source)
     VALUES (?, ?, 'technical', NULL, 'user')`,
  );
  const selectAll = db.prepare(`SELECT tag FROM asset_tags WHERE asset_id = ?`);
  const updateAssets = db.prepare(`UPDATE assets SET tags = ? WHERE id = ?`);

  const tx = db.transaction(() => {
    deleteUser.run(assetId);
    for (const tag of cleaned) {
      insertUser.run(assetId, tag);
    }
    const merged = Array.from(
      new Set((selectAll.all(assetId) as { tag: string }[]).map((r) => r.tag)),
    );
    updateAssets.run(merged.length > 0 ? JSON.stringify(merged) : null, assetId);
  });
  tx();
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
  const selectAll = db.prepare('SELECT tag FROM asset_tags WHERE asset_id = ?');
  // Re-writing the JSON mirror is what fires `assets_fts_au`, so search and the
  // tag filter see the change with no extra work — same contract as setAssetTags.
  const updateAssets = db.prepare('UPDATE assets SET tags = ? WHERE id = ?');

  const tx = db.transaction(() => {
    for (const assetId of assetIds) {
      for (const tag of cleaned) insertUser.run(assetId, tag);
      const merged = Array.from(
        new Set((selectAll.all(assetId) as { tag: string }[]).map((r) => r.tag)),
      );
      updateAssets.run(merged.length > 0 ? JSON.stringify(merged) : null, assetId);
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
  const like = `%${query.toLowerCase()}%`;
  return db
    .prepare(
      `SELECT tag, COUNT(*) AS count, tag_type
       FROM asset_tags
       WHERE LOWER(tag) LIKE ?
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
