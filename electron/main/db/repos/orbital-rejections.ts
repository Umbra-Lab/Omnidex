import type { Database } from 'better-sqlite3';

/**
 * Match-queue decisions the user made, kept so they survive a reload.
 *
 * Two verbs, distinguished by whether `product_slug` is set — see the
 * migration for why neither can be derived from the other:
 *
 *   rejectCandidate  "this listing is not this pack"      (asset stays queued)
 *   dismissAsset     "nothing on Orbital is this pack"    (asset leaves)
 */

/** "This candidate is wrong for this asset." Keeps the asset in the queue. */
export function rejectCandidate(db: Database, assetId: number, slug: string): void {
  db.prepare(
    `INSERT INTO orbital_match_rejections (asset_id, product_slug) VALUES (?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(assetId, slug);
}

/** "Nothing on Orbital is this pack." Removes the asset from the queue. */
export function dismissAsset(db: Database, assetId: number): void {
  db.prepare(
    `INSERT INTO orbital_match_rejections (asset_id, product_slug) VALUES (?, NULL)
     ON CONFLICT DO NOTHING`,
  ).run(assetId);
}

/**
 * Undo one decision. Pass a slug to un-reject that candidate, or null to
 * un-dismiss the asset and put it back in the queue.
 *
 * `IS ?` rather than `= ?` so a null slug matches the dismissal row; `= NULL`
 * is never true in SQL and would silently delete nothing.
 */
export function undoRejection(db: Database, assetId: number, slug: string | null): void {
  db.prepare('DELETE FROM orbital_match_rejections WHERE asset_id = ? AND product_slug IS ?').run(
    assetId,
    slug,
  );
}

/** Slugs already rejected for this asset, so the compare pane can skip them. */
export function rejectedSlugsFor(db: Database, assetId: number): string[] {
  const rows = db
    .prepare(
      `SELECT product_slug FROM orbital_match_rejections
        WHERE asset_id = ? AND product_slug IS NOT NULL`,
    )
    .all(assetId) as { product_slug: string }[];
  return rows.map((r) => r.product_slug);
}

/** True when the user dismissed this asset outright. */
export function isDismissed(db: Database, assetId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM orbital_match_rejections
        WHERE asset_id = ? AND product_slug IS NULL LIMIT 1`,
    )
    .get(assetId) as { hit: number } | undefined;
  return row != null;
}

/**
 * Clear every rejection for an asset.
 *
 * Called when a match is accepted: an explicit accept is a stronger statement
 * than any earlier "not this one", and leaving stale rows would keep a matched
 * pack out of a re-review it may later need.
 */
export function clearForAsset(db: Database, assetId: number): void {
  db.prepare('DELETE FROM orbital_match_rejections WHERE asset_id = ?').run(assetId);
}
