/**
 * The scan upsert statement, on its own so it can be read without loading a
 * native addon.
 *
 * This lived in `pipeline.ts`, which statically imports `@omnidex/uasset` for
 * thumbnail extraction. That made importing a SQL string enough to load the
 * napi binding, so the curation regression test passed on Windows (where the
 * `.node` exists) and failed in CI on Linux (where it does not) with "Cannot
 * find native binding" — a test failing over a platform binary it never used.
 *
 * Keyed on the unique `file_path`, so a pack that is re-seen keeps its id — and
 * therefore its collections, tags and notes. Exported so tests bind to the real
 * statement instead of a copy that can drift away from it.
 */
export const ASSET_UPSERT_SQL = `INSERT INTO assets (
       name, file_path, asset_type, file_size, file_size_is_partial,
       created_date, modified_date,
       scan_location_id, is_favorite, ecosystem, asset_ecosystem, content_format
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       name = excluded.name,
       asset_type = excluded.asset_type,
       file_size = excluded.file_size,
       file_size_is_partial = excluded.file_size_is_partial,
       modified_date = excluded.modified_date,
       ecosystem = excluded.ecosystem,
       asset_ecosystem = excluded.asset_ecosystem,
       scan_location_id = excluded.scan_location_id,
       content_format = excluded.content_format,
       -- A path that is back on disk is not missing any more. The prune stamps
       -- curated rows instead of deleting them, so this is the other half of
       -- that: move a pack away, scan, move it back, scan — and its
       -- collections, tags and notes are still attached.
       missing_since = NULL`;
