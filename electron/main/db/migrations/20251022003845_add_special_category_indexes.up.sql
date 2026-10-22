-- Add indexes for special category queries (Favorites and FAB Assets)
-- These indexes optimize WHERE clauses + ORDER BY for performance targets (<50ms for 10k assets)

-- Compound indexes for Favorites query (WHERE is_favorite = 1 ORDER BY ...)
-- These cover both filtering and sorting in a single index lookup
CREATE INDEX IF NOT EXISTS idx_assets_favorite_name ON assets(is_favorite, name);
CREATE INDEX IF NOT EXISTS idx_assets_favorite_created_date ON assets(is_favorite, created_date);
CREATE INDEX IF NOT EXISTS idx_assets_favorite_modified_date ON assets(is_favorite, modified_date);

-- Compound indexes for FAB Assets query (WHERE scan_location_id = -1 ORDER BY ...)
CREATE INDEX IF NOT EXISTS idx_assets_scan_location_name ON assets(scan_location_id, name);
CREATE INDEX IF NOT EXISTS idx_assets_scan_location_created_date ON assets(scan_location_id, created_date);
CREATE INDEX IF NOT EXISTS idx_assets_scan_location_modified_date ON assets(scan_location_id, modified_date);
