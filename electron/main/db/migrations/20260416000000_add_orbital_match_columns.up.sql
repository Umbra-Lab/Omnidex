-- Phase 19: Orbital Match Overhaul — Add ecosystem and match-tracking columns.
--
-- asset_ecosystem: Separate from the existing `ecosystem` column (added in an earlier migration).
--   Both coexist during Phase 19. This column stores the classification used by the Phase 19
--   matching pipeline. Defaults to 'unreal_engine' for new rows but is immediately backfilled
--   from the already-correct `ecosystem` column so that C4D/Blender assets are not incorrectly
--   passed through the Unreal Engine matching gate.
--
-- orbital_match_attempted: Distinguishes "never tried" (0) from "tried, no match found" (1).
--   SQLite stores BOOLEAN as INTEGER (0 = false, 1 = true).

ALTER TABLE assets ADD COLUMN asset_ecosystem TEXT DEFAULT 'unreal_engine';
ALTER TABLE assets ADD COLUMN orbital_match_attempted INTEGER NOT NULL DEFAULT 0;

-- CRITICAL BACKFILL: copy the already-correct `ecosystem` value into `asset_ecosystem`.
-- Without this, all existing C4D/AE/Houdini/Blender assets would have asset_ecosystem =
-- 'unreal_engine' (the DEFAULT), causing them to pass the ecosystem gate and receive wrong
-- Unreal Engine marketplace matches.
UPDATE assets SET asset_ecosystem = ecosystem;
