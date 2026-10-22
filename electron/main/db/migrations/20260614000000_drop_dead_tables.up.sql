-- Debt reduction: drop dead, never-written schema left over from removed features.
--
-- Every object dropped here has ZERO runtime references in the TypeScript
-- codebase (verified across electron/, renderer-react/, and shared/). The
-- feature code that once wrote these tables was removed along with the legacy
-- `omnidex:command` IPC bus; nothing reads or writes them today.
--
-- DROP TABLE IF EXISTS is used throughout so this is a no-op on catalogs that
-- never received the originating migrations (e.g. a fresh in-memory test DB
-- that applies the full chain still drops cleanly).
--
-- Objects are dropped child-before-parent because `PRAGMA foreign_keys = ON`
-- is set on the runtime connection (electron/main/db/connection.ts).
--
-- DELIBERATELY KEPT (do NOT add to this list):
--   * assets / scan_locations / collections / asset_tags / asset_notes /
--     orbital_* / settings — the live catalog.
--   * assets_v2, asset_marketplace_matches, orbital_metadata, fab_metadata,
--     marketplace_metadata — the normalized cluster. Although the enrich
--     pipeline never WRITES asset_marketplace_matches, it is still READ by live
--     code: the "Unmatched" / "orbital" / "fab" / "epic" sidebar category
--     filters and the marketplace source counts in
--     electron/main/db/repos/assets.ts run `SELECT asset_id FROM
--     asset_marketplace_matches` subqueries. Dropping it would turn those into
--     "no such table" errors. The rest of the cluster is its FK parent
--     (assets_v2) and FK children (orbital_metadata / fab_metadata /
--     marketplace_metadata), so the cluster is kept intact.

-- asset_usage tracking (Epic 3 Story 3.3) — table + its two dependent views.
-- Views first: they reference asset_usage and would dangle otherwise.
DROP VIEW  IF EXISTS recent_activity;
DROP VIEW  IF EXISTS asset_usage_stats;
DROP TABLE IF EXISTS asset_usage;

-- Promotion pipeline (Phase 14) — append-only history log. FK -> projects.
DROP TABLE IF EXISTS promotion_history;

-- Validation pre-flight (Phase 13) — overrides. FK -> projects.
DROP TABLE IF EXISTS validation_overrides;

-- Project workspace (Phase 12) — asset_project_tags (FK -> projects) before
-- the projects parent.
DROP TABLE IF EXISTS asset_project_tags;
DROP TABLE IF EXISTS projects;
