-- Epic 3 Story 3.5: Database Performance Indexes
-- Covering indexes for commonly queried columns

-- Covering index for tag lookup queries (tag + type together)
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag_type_covering
ON asset_tags(tag, tag_type, confidence);

-- Index for date-based filtering on assets
CREATE INDEX IF NOT EXISTS idx_assets_created_date ON assets(created_date);
CREATE INDEX IF NOT EXISTS idx_assets_modified_date_desc ON assets(modified_date DESC);

-- Index for notes with rating for filtering
CREATE INDEX IF NOT EXISTS idx_asset_notes_asset_rating
ON asset_notes(asset_id, rating) WHERE rating IS NOT NULL;

-- Index for searching assets with notes
CREATE INDEX IF NOT EXISTS idx_asset_notes_has_content
ON asset_notes(asset_id) WHERE note_text IS NOT NULL AND note_text != '';

-- Index for collection item counts and sorting
CREATE INDEX IF NOT EXISTS idx_collection_items_collection_sort
ON collection_items(collection_id, sort_order, added_at);

-- Index for finding assets in any collection
CREATE INDEX IF NOT EXISTS idx_collection_items_asset_collections
ON collection_items(asset_id, collection_id);

-- Index for marketplace matches (commonly joined)
CREATE INDEX IF NOT EXISTS idx_marketplace_matches_asset
ON asset_marketplace_matches(asset_id, marketplace);

-- Partial index for verified matches
CREATE INDEX IF NOT EXISTS idx_marketplace_matches_verified
ON asset_marketplace_matches(asset_id) WHERE verified = 1;

-- Index for file path lookups
CREATE INDEX IF NOT EXISTS idx_assets_file_path
ON assets(file_path);

-- ANALYZE tables to update statistics for query planner
ANALYZE assets;
ANALYZE asset_tags;
ANALYZE asset_notes;
ANALYZE collections;
ANALYZE collection_items;
ANALYZE asset_usage;
