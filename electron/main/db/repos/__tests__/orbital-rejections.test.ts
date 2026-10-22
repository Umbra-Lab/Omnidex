import type { AssetFilter } from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countAssets, getAssetStats, listAssetCards, pruneAssetsNotIn } from '../assets';
import {
  clearForAsset,
  dismissAsset,
  isDismissed,
  rejectCandidate,
  rejectedSlugsFor,
  undoRejection,
} from '../orbital-rejections';
import { createTestDb, seedAsset } from './fixtures/test-db';

/**
 * The Match queue's memory.
 *
 * Before this the queue remembered decisions in a React Set: reopening Match
 * re-offered the same wrong candidate for the same pack, forever. The two verbs
 * below are separate on purpose — see the migration.
 */

let db: Database;

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  (db as unknown as { close: () => void }).close();
});

const NO_FILTER: AssetFilter = {
  asset_type: null,
  tags: null,
  name_search: null,
  is_favorite: null,
  scan_location_id: null,
  date_range: null,
  category: null,
  ecosystem: null,
};
const filter = (o: Partial<AssetFilter>): AssetFilter => ({ ...NO_FILTER, ...o });

describe('rejecting one candidate', () => {
  it('records the slug without removing the asset from the queue', () => {
    const id = seedAsset(db, { name: 'Mystery Pack', file_path: '/m' });
    rejectCandidate(db, id, 'wrong-pack');

    expect(rejectedSlugsFor(db, id)).toEqual(['wrong-pack']);
    // Still queued — the listing was wrong, the pack is not done.
    expect(countAssets(db, filter({ match_status: 'needs_review' }))).toBe(1);
  });

  it('is idempotent, so a double-press cannot duplicate', () => {
    const id = seedAsset(db, { name: 'Mystery Pack', file_path: '/m' });
    rejectCandidate(db, id, 'wrong-pack');
    rejectCandidate(db, id, 'wrong-pack');
    expect(rejectedSlugsFor(db, id)).toEqual(['wrong-pack']);
  });

  it('keeps rejections separate per asset', () => {
    const a = seedAsset(db, { name: 'A', file_path: '/a' });
    const b = seedAsset(db, { name: 'B', file_path: '/b' });
    rejectCandidate(db, a, 'slug-1');
    expect(rejectedSlugsFor(db, b)).toEqual([]);
  });
});

describe('dismissing an asset', () => {
  it('removes it from the queue', () => {
    const id = seedAsset(db, { name: 'Not On Orbital', file_path: '/n' });
    expect(countAssets(db, filter({ match_status: 'needs_review' }))).toBe(1);

    dismissAsset(db, id);
    expect(countAssets(db, filter({ match_status: 'needs_review' }))).toBe(0);
    expect(isDismissed(db, id)).toBe(true);
  });

  it('is idempotent — the NULL slug cannot be stored twice', () => {
    // A plain UNIQUE(asset_id, product_slug) would allow this, because SQLite
    // treats NULLs as distinct. The COALESCE index is what makes it hold.
    const id = seedAsset(db, { name: 'Dupe', file_path: '/d' });
    dismissAsset(db, id);
    dismissAsset(db, id);
    const n = (
      db.prepare('SELECT COUNT(*) AS n FROM orbital_match_rejections').get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it('does NOT change the Unmatched facet, which describes the data', () => {
    const id = seedAsset(db, { name: 'Dismissed', file_path: '/x' });
    dismissAsset(db, id);
    // Still unmatched: no seller, no rating, no source URL. Dismissal is a fact
    // about the user's queue, not about the row.
    expect(countAssets(db, filter({ match_status: 'unmatched' }))).toBe(1);
    expect(getAssetStats(db).unmatched).toBe(1);
    // But the queue is empty.
    expect(getAssetStats(db).needs_review).toBe(0);
  });

  it('leaves matched assets out of both counts', () => {
    seedAsset(db, { name: 'Matched', file_path: '/m', matched_orbital_product_slug: 'real-pack' });
    expect(getAssetStats(db).unmatched).toBe(0);
    expect(getAssetStats(db).needs_review).toBe(0);
  });
});

describe('undo', () => {
  it('puts a dismissed asset back in the queue', () => {
    const id = seedAsset(db, { name: 'Back', file_path: '/b' });
    dismissAsset(db, id);
    undoRejection(db, id, null);
    expect(countAssets(db, filter({ match_status: 'needs_review' }))).toBe(1);
    expect(isDismissed(db, id)).toBe(false);
  });

  it('un-rejects one candidate without touching the others', () => {
    const id = seedAsset(db, { name: 'Multi', file_path: '/m' });
    rejectCandidate(db, id, 'a');
    rejectCandidate(db, id, 'b');
    undoRejection(db, id, 'a');
    expect(rejectedSlugsFor(db, id)).toEqual(['b']);
  });

  it('undoing a dismissal does not remove candidate rejections', () => {
    // `= NULL` is never true in SQL; the repo uses `IS ?` so the null case
    // matches the dismissal row and only that row.
    const id = seedAsset(db, { name: 'Mixed', file_path: '/m' });
    rejectCandidate(db, id, 'a');
    dismissAsset(db, id);
    undoRejection(db, id, null);
    expect(rejectedSlugsFor(db, id)).toEqual(['a']);
    expect(isDismissed(db, id)).toBe(false);
  });
});

describe('accepting a match', () => {
  it('clears every rejection for the asset', () => {
    const id = seedAsset(db, { name: 'Settled', file_path: '/s' });
    rejectCandidate(db, id, 'a');
    dismissAsset(db, id);
    clearForAsset(db, id);
    expect(rejectedSlugsFor(db, id)).toEqual([]);
    expect(isDismissed(db, id)).toBe(false);
  });
});

describe('a rejection survives a folder rename', () => {
  it('is treated as curation by the prune, not discarded', () => {
    // Same class of loss the collection/tag guard exists for: rename → the old
    // path stops appearing in the walk → prune. If the row is hard-deleted the
    // cascade takes the decision, and the pack returns on the next scan as a
    // fresh id offering the candidate the user already turned down.
    const id = seedAsset(db, { name: 'Renamed', file_path: '/old/path' });
    rejectCandidate(db, id, 'wrong-pack');

    pruneAssetsNotIn(db, 1, ['/some/other/path']);

    const row = db.prepare('SELECT id, missing_since FROM assets WHERE id = ?').get(id) as
      | { id: number; missing_since: string | null }
      | undefined;
    expect(row, 'the asset must survive as a soft-delete').toBeDefined();
    expect(row?.missing_since).not.toBeNull();
    expect(rejectedSlugsFor(db, id)).toEqual(['wrong-pack']);
  });

  it('still hard-deletes an asset carrying no decision at all', () => {
    const id = seedAsset(db, { name: 'Uncurated', file_path: '/gone' });
    pruneAssetsNotIn(db, 1, ['/still/here']);
    expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(id)).toBeUndefined();
  });
});

describe('listCards honours the queue predicate', () => {
  it('omits dismissed assets and keeps rejected-candidate ones', () => {
    const kept = seedAsset(db, { name: 'Kept', file_path: '/k' });
    const gone = seedAsset(db, { name: 'Gone', file_path: '/g' });
    rejectCandidate(db, kept, 'a-wrong-listing');
    dismissAsset(db, gone);

    const rows = listAssetCards(db, { filter: filter({ match_status: 'needs_review' }) });
    expect(rows.map((r) => r.name)).toEqual(['Kept']);
  });
});
