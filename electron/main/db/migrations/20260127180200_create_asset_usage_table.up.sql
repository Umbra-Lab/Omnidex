-- Epic 3 Story 3.3: Asset Usage Tracking Database Schema
-- Track when and how assets are accessed for insights and analytics

CREATE TABLE IF NOT EXISTS asset_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    access_type TEXT CHECK(access_type IN ('view', 'export', 'project_match', 'collection_add', 'tag_add', 'favorite')) NOT NULL,
    context TEXT,               -- Optional JSON context (e.g., which project, collection)
    accessed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- Composite index for frequency queries and time-based filtering
CREATE INDEX IF NOT EXISTS idx_asset_usage_asset_time ON asset_usage(asset_id, accessed_at DESC);

-- Index for filtering by access type
CREATE INDEX IF NOT EXISTS idx_asset_usage_type ON asset_usage(access_type);

-- Index for time-based queries (e.g., "most used this week")
CREATE INDEX IF NOT EXISTS idx_asset_usage_accessed_at ON asset_usage(accessed_at DESC);

-- View for aggregated usage statistics
CREATE VIEW IF NOT EXISTS asset_usage_stats AS
SELECT
    asset_id,
    COUNT(*) as total_accesses,
    COUNT(CASE WHEN access_type = 'view' THEN 1 END) as view_count,
    COUNT(CASE WHEN access_type = 'export' THEN 1 END) as export_count,
    COUNT(CASE WHEN access_type = 'project_match' THEN 1 END) as match_count,
    COUNT(CASE WHEN access_type = 'collection_add' THEN 1 END) as collection_count,
    MAX(accessed_at) as last_accessed,
    MIN(accessed_at) as first_accessed
FROM asset_usage
GROUP BY asset_id;

-- View for recent activity (last 7 days)
CREATE VIEW IF NOT EXISTS recent_activity AS
SELECT
    au.asset_id,
    a.name as asset_name,
    au.access_type,
    au.accessed_at,
    au.context
FROM asset_usage au
JOIN assets a ON a.id = au.asset_id
WHERE au.accessed_at >= datetime('now', '-7 days')
ORDER BY au.accessed_at DESC;
