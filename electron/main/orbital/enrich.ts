import type { Statement } from 'better-sqlite3';
import { openDatabase } from '../db';
import { type ActionProgress, emitProgress } from '../progress/bus';
import { matchAssetName } from './matcher';
import { getProduct } from './product';
import { mapOrbitalDetailToAssetFields } from './product-mapping';

/**
 * Orbital enrichment service.
 *
 * Relocated from `index.ts`'s `runEnrichOrbitalAndQuit` body (minus
 * `app.exit`) so enrichment is callable from both the CLI and tRPC. Field
 * mapping now lives in the shared `mapOrbitalDetailToAssetFields` helper
 * (also used by the manual-match path) — no algorithm change, no change to
 * which data is fetched. Progress is published to the shared `progressBus`;
 * the CLI attaches a console logger to it.
 *
 * Politeness / efficiency posture (WS6 Track 4):
 *   - Candidates are rows that are genuinely un-enriched AND not already
 *     attempted, so a row that was tried and found unmatched (or failed
 *     transiently) does NOT re-qualify on the next run — we never redo failed
 *     network work in a loop.
 *   - Malformed legacy rows (description stored as raw `{...}` JSON) DO
 *     re-qualify, but they are overwritten in place ONLY after a successful
 *     re-fetch. We no longer bulk-NULL them up front, so a transient network
 *     failure can never erase a row's prior data.
 */

export interface EnrichOrbitalOptions {
  /** Direct progress sink (testable). Defaults to the shared `progressBus`. */
  onProgress?: (p: ActionProgress) => void;
  signal?: AbortSignal;
  /** Emit a `phase:'progress'` event every N rows. Default 25 (log cadence). */
  emitEvery?: number;
}

export interface EnrichResult {
  total: number;
  matched: number;
  unmatched: number;
  failed: number;
}

// Stores everything the inspector reads. Gallery is JSON-stringified array of
// {url} objects to match the existing `parseGallery` reader on the renderer
// side. Prepared once per call against the shared `openDatabase()` connection.
const UPDATE_SQL = `UPDATE assets SET
       matched_orbital_product_slug = ?,
       orbital_match_confidence = ?,
       orbital_match_type = ?,
       orbital_match_attempted = 1,
       orbital_title = COALESCE(?, orbital_title),
       orbital_description = ?,
       orbital_technical_details = ?,
       orbital_seller_name = ?,
       orbital_price = ?,
       orbital_release_date = ?,
       orbital_last_modified = ?,
       orbital_rating_average = ?,
       orbital_rating_count = ?,
       orbital_categories = ?,
       orbital_supported_versions = ?,
       orbital_gallery_images = ?,
       orbital_thumbnail_url = ?,
       orbital_source_url = ?,
       orbital_last_checked_timestamp = ?
     WHERE id = ?`;

type UpdateStmt = Statement<unknown[]>;

/**
 * Map an Orbital product detail onto the asset row via `updateStmt`, using the
 * shared field-mapper (`mapOrbitalDetailToAssetFields`) so this write path and
 * the manual-match path in `commands.ts` agree on field shapes. The UPDATE
 * overwrites every orbital column, so a successful re-fetch fully replaces any
 * prior (possibly malformed) value in place — clearing only AFTER success.
 */
function applyProductDetail(
  updateStmt: UpdateStmt,
  detail: NonNullable<Awaited<ReturnType<typeof getProduct>>>,
  matchScore: number,
  matchStrength: string,
  assetId: number,
): void {
  const m = mapOrbitalDetailToAssetFields(detail);
  updateStmt.run(
    m.slug,
    matchScore,
    matchStrength,
    m.title,
    m.description,
    m.technical,
    m.seller,
    m.priceCents,
    m.releaseDate,
    m.lastModified,
    m.ratingAvg,
    m.ratingCount,
    m.categories,
    m.supportedVersions,
    m.gallery,
    m.heroUrl,
    m.sourceUrl,
    new Date().toISOString(),
    assetId,
  );
}

export async function enrichOrbital(opts: EnrichOrbitalOptions = {}): Promise<EnrichResult> {
  const emit = opts.onProgress ?? emitProgress;
  const emitEvery = opts.emitEvery ?? 25;
  const db = openDatabase();

  // Count (do NOT mutate) malformed legacy rows: a previous enrich run
  // JSON-stringified the wrong top-level fields and stored objects like
  // `{"long":"<HTML>"}` into `orbital_description`. We surface the count in
  // the start message, but we do NOT pre-NULL these rows — they re-qualify
  // as candidates below and are overwritten in place ONLY after a successful
  // re-fetch (clear-after-success), so a transient network failure can never
  // erase their prior data.
  const malformedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM assets
         WHERE content_format IS NULL
           AND scan_location_id > 0
           AND orbital_description LIKE '{%'`,
      )
      .get() as { n: number }
  ).n;

  // Candidates: un-enriched rows that have NOT already been attempted, PLUS
  // malformed legacy rows (regardless of attempted) so they get re-fetched
  // and repaired. The `orbital_match_attempted = 0` gate is what stops a row
  // that was tried-and-unmatched (or failed) from re-qualifying every run —
  // we never redo failed network work in a loop.
  const rows = db
    .prepare(
      `SELECT id, name, orbital_title FROM assets
       WHERE content_format IS NULL
         AND scan_location_id > 0
         AND (
           ((orbital_description IS NULL OR orbital_description = '')
             AND orbital_match_attempted = 0)
           OR orbital_description LIKE '{%'
         )
       ORDER BY id`,
    )
    .all() as { id: number; name: string; orbital_title: string | null }[];

  const total = rows.length;
  const updateStmt = db.prepare(UPDATE_SQL);
  const markAttempted = db.prepare('UPDATE assets SET orbital_match_attempted = 1 WHERE id = ?');

  let matched = 0;
  let unmatched = 0;
  let failed = 0;
  const t0 = Date.now();

  emit({
    action: 'enrich-orbital',
    phase: 'start',
    processed: 0,
    total,
    currentName: null,
    matched,
    unmatched,
    failed,
    message:
      malformedCount > 0
        ? `${total} asset(s) need orbital enrichment (${malformedCount} malformed row(s) to repair)`
        : `${total} asset(s) need orbital enrichment`,
  });

  for (let i = 0; i < rows.length; i += 1) {
    if (opts.signal?.aborted) break;
    const row = rows[i];
    if (!row) continue;
    const folderName = row.orbital_title ?? row.name;
    try {
      let candidates: Awaited<ReturnType<typeof matchAssetName>>;
      try {
        candidates = await matchAssetName(folderName, 5);
      } catch (e) {
        throw new Error(`matchAssetName threw: ${(e as Error).message}`);
      }
      const top = candidates[0];
      if (!top || top.strength === 'none') {
        markAttempted.run(row.id);
        unmatched += 1;
      } else {
        let detail: Awaited<ReturnType<typeof getProduct>>;
        try {
          detail = await getProduct(top.item.slug);
        } catch (e) {
          throw new Error(`getProduct(${top.item.slug}) threw: ${(e as Error).message}`);
        }
        if (!detail) {
          markAttempted.run(row.id);
          unmatched += 1;
        } else {
          applyProductDetail(updateStmt, detail, top.score, top.strength, row.id);
          matched += 1;
        }
      }
    } catch (e) {
      failed += 1;
      // Mark attempted on transient failure so this row stops re-qualifying as
      // a candidate on the next run — we do not redo failed network work in a
      // loop. (Bound = 1 attempt, gated on the existing `orbital_match_attempted`
      // column. A graduated retry COUNT would need a new column/migration, which
      // is out of Track 4's file scope — see the WS6 flags.) Malformed legacy
      // rows still re-qualify via the `LIKE '{%'` clause until repaired by a
      // successful re-fetch, which is the intended behavior.
      markAttempted.run(row.id);
      const err = e as Error;
      emit({
        action: 'enrich-orbital',
        phase: 'error',
        processed: i + 1,
        total,
        currentName: folderName,
        matched,
        unmatched,
        failed,
        message: `FAIL [${row.id}] ${folderName}: ${err.message}`,
      });
    }

    if ((i + 1) % emitEvery === 0 || i + 1 === total) {
      const elapsedMs = Date.now() - t0;
      const etaSeconds =
        i + 1 < total ? Math.round(((total - i - 1) * elapsedMs) / (i + 1) / 1000) : 0;
      emit({
        action: 'enrich-orbital',
        phase: 'progress',
        processed: i + 1,
        total,
        currentName: folderName,
        matched,
        unmatched,
        failed,
        etaSeconds,
        message: `${i + 1}/${total} matched=${matched} unmatched=${unmatched} failed=${failed}`,
      });
    }
  }

  emit({
    action: 'enrich-orbital',
    phase: 'done',
    processed: total,
    total,
    currentName: null,
    matched,
    unmatched,
    failed,
    message: `complete — matched=${matched} unmatched=${unmatched} failed=${failed}`,
  });

  return { total, matched, unmatched, failed };
}

/**
 * Single-asset enrichment for the renderer's per-card "match" action. When
 * `slug` is supplied, skip `matchAssetName` and fetch that product directly;
 * otherwise rank candidates and take the top non-`none` hit. Writes through
 * the same `updateStmt` against one row.
 */
export async function enrichOneOrbital(assetId: number, slug?: string): Promise<EnrichResult> {
  const db = openDatabase();
  const updateStmt = db.prepare(UPDATE_SQL);
  const markAttempted = db.prepare('UPDATE assets SET orbital_match_attempted = 1 WHERE id = ?');

  const row = db
    .prepare('SELECT id, name, orbital_title FROM assets WHERE id = ?')
    .get(assetId) as { id: number; name: string; orbital_title: string | null } | undefined;
  if (!row) {
    return { total: 0, matched: 0, unmatched: 0, failed: 0 };
  }

  const folderName = row.orbital_title ?? row.name;

  if (slug) {
    const detail = await getProduct(slug);
    if (!detail) {
      markAttempted.run(row.id);
      return { total: 1, matched: 0, unmatched: 1, failed: 0 };
    }
    // Direct slug pick: caller asserted the match, so record it at full
    // confidence as an explicit selection.
    applyProductDetail(updateStmt, detail, 1, 'exact', row.id);
    return { total: 1, matched: 1, unmatched: 0, failed: 0 };
  }

  const candidates = await matchAssetName(folderName, 5);
  const top = candidates[0];
  if (!top || top.strength === 'none') {
    markAttempted.run(row.id);
    return { total: 1, matched: 0, unmatched: 1, failed: 0 };
  }
  const detail = await getProduct(top.item.slug);
  if (!detail) {
    markAttempted.run(row.id);
    return { total: 1, matched: 0, unmatched: 1, failed: 0 };
  }
  applyProductDetail(updateStmt, detail, top.score, top.strength, row.id);
  return { total: 1, matched: 1, unmatched: 0, failed: 0 };
}
