-- Curation must outlive a folder rename.
--
-- Seven tables cascade off assets(id) ON DELETE CASCADE, three of which hold
-- things the user typed and the app can never re-derive: collection_items,
-- asset_tags, asset_notes. The scanner's reconciliation prune deletes any row
-- for a location whose file_path was not seen in the walk — which is correct
-- for a pack that was genuinely deleted, and catastrophic for one that was
-- merely moved or renamed, because the same pack comes back on the next scan
-- under a fresh autoincrement id with nothing linking it to what it was.
--
-- The live library shows the damage plainly: 3,010 rows against a
-- sqlite_sequence of 16,098, and collection_items / asset_tags / asset_notes
-- all at zero. The only curation that survived is is_favorite, and only
-- because it is a column on assets rather than a child row.
--
-- `missing_since` lets the prune soft-delete instead. A row carrying curation
-- is stamped rather than dropped, so its id — and everything hanging off it —
-- survives. Re-seeing the path clears the stamp.
ALTER TABLE assets ADD COLUMN missing_since TEXT;

-- The grid filters on this on every list query, and the prune reads it back.
CREATE INDEX IF NOT EXISTS idx_assets_missing_since ON assets(missing_since);
