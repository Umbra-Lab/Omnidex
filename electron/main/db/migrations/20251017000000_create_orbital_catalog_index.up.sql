-- Create catalog index table for full Orbital Market product cache
-- This stores the complete product JSON from the search endpoint for fast lookups
CREATE TABLE IF NOT EXISTS orbital_catalog_index (
    slug TEXT PRIMARY KEY NOT NULL,           -- Product slug (primary key for O(1) lookup)
    title TEXT NOT NULL,                      -- Product title for display/search
    category TEXT,                            -- Product category (vfx, models, plugins, etc.)
    owner_name TEXT,                          -- Creator/seller name
    price_usd INTEGER,                        -- Price in cents (0 for free)
    thumbnail_url TEXT,                       -- Product thumbnail image URL
    description_long TEXT,                    -- Long description
    technical_details TEXT,                   -- Technical requirements
    engine_min TEXT,                          -- Min UE version supported
    engine_max TEXT,                          -- Max UE version supported
    rating_average REAL,                      -- Average rating (0-5)
    rating_count INTEGER,                     -- Number of ratings
    release_date TEXT,                        -- Release date ISO 8601
    cached_data TEXT NOT NULL,                -- Full API response JSON (for detail inspector)
    indexed_at TEXT NOT NULL DEFAULT (datetime('now')), -- When this was added to index
    last_updated TEXT NOT NULL DEFAULT (datetime('now')) -- When this was last fetched
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_catalog_title ON orbital_catalog_index(title);
CREATE INDEX IF NOT EXISTS idx_catalog_category ON orbital_catalog_index(category);
CREATE INDEX IF NOT EXISTS idx_catalog_owner ON orbital_catalog_index(owner_name);
CREATE INDEX IF NOT EXISTS idx_catalog_indexed_at ON orbital_catalog_index(indexed_at);

-- Track catalog sync operations
CREATE TABLE IF NOT EXISTS orbital_catalog_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_started_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_completed_at TEXT,                   -- NULL if still syncing
    total_products INTEGER,                   -- Total products fetched
    total_bytes INTEGER,                      -- Total data downloaded
    pages_fetched INTEGER,                    -- Number of pages fetched
    errors_encountered INTEGER DEFAULT 0,     -- Number of errors during sync
    error_messages TEXT,                      -- JSON array of error details
    status TEXT NOT NULL DEFAULT 'in_progress' -- 'in_progress', 'completed', 'failed'
);

CREATE INDEX IF NOT EXISTS idx_sync_started ON orbital_catalog_sync(sync_started_at);
CREATE INDEX IF NOT EXISTS idx_sync_status ON orbital_catalog_sync(status);
