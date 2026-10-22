-- Add index on scraper_metrics.metric_type for faster aggregation queries
-- This significantly speeds up COUNT(*) queries grouped by metric_type
-- used in get_scraper_metrics() command

CREATE INDEX IF NOT EXISTS idx_scraper_metrics_type
ON scraper_metrics(metric_type);

-- Add composite index for session-based queries (if needed in future)
CREATE INDEX IF NOT EXISTS idx_scraper_metrics_session_type
ON scraper_metrics(session_id, metric_type);

-- Add index on timestamp for efficient time-range queries and cleanup operations
CREATE INDEX IF NOT EXISTS idx_scraper_metrics_timestamp
ON scraper_metrics(timestamp);
