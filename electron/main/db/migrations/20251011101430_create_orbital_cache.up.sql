-- Create orbital product cache table for efficient scraping
CREATE TABLE IF NOT EXISTS orbital_product_cache (
    product_slug TEXT PRIMARY KEY NOT NULL,
    cached_data TEXT NOT NULL,              -- JSON response from Orbital API
    last_fetched_timestamp TEXT NOT NULL,   -- ISO 8601 timestamp
    expires_at TEXT NOT NULL,               -- When this cache entry expires
    etag TEXT,                              -- HTTP ETag for conditional requests
    response_time_ms INTEGER,               -- Track API performance
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for finding expired entries
CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON orbital_product_cache(expires_at);

-- Index for performance tracking
CREATE INDEX IF NOT EXISTS idx_cache_response_time ON orbital_product_cache(response_time_ms);

-- Add index to assets table for deduplication
CREATE INDEX IF NOT EXISTS idx_assets_orbital_slug
ON assets(matched_orbital_product_slug)
WHERE matched_orbital_product_slug IS NOT NULL;

-- Create table for scraper metrics
CREATE TABLE IF NOT EXISTS scraper_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    metric_type TEXT NOT NULL,              -- 'request', 'cache_hit', 'cache_miss', 'rate_limit', etc.
    value REAL NOT NULL,
    metadata TEXT,                          -- JSON for additional context
    session_id TEXT                         -- Track per-scan session
);

CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON scraper_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_type ON scraper_metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_metrics_session ON scraper_metrics(session_id);
