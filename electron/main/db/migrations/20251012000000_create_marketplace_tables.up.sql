-- Marketplace cache table
-- Stores search results with 24-hour TTL to avoid redundant API calls
CREATE TABLE IF NOT EXISTS marketplace_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT UNIQUE NOT NULL,
    results TEXT NOT NULL, -- JSON array of MarketplaceAsset objects
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL -- created_at + 24 hours
);

CREATE INDEX IF NOT EXISTS idx_marketplace_cache_key ON marketplace_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_marketplace_cache_expires ON marketplace_cache(expires_at);

-- Marketplace assets table
-- Normalized storage for marketplace asset data
CREATE TABLE IF NOT EXISTS marketplace_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace_id TEXT NOT NULL, -- e.g., "fab_12345", "orbital_67890"
    marketplace TEXT NOT NULL, -- "orbital", "fab", "artstation", "gumroad"
    title TEXT NOT NULL,
    description TEXT,
    thumbnail_url TEXT,
    url TEXT NOT NULL, -- Marketplace page URL
    categories TEXT, -- JSON array of category strings
    creator TEXT,
    ue_versions TEXT, -- JSON array of UE version strings
    orbital_id TEXT, -- Cross-reference to Orbital Market
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(marketplace, marketplace_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_assets_marketplace ON marketplace_assets(marketplace);
CREATE INDEX IF NOT EXISTS idx_marketplace_assets_orbital_id ON marketplace_assets(orbital_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_assets_title ON marketplace_assets(title);

-- Marketplace scores table
-- Caches LLM relevance scores to reduce API costs
CREATE TABLE IF NOT EXISTS marketplace_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marketplace_asset_id INTEGER NOT NULL,
    project_hash TEXT NOT NULL, -- Hash of ProjectContext
    relevance_score REAL NOT NULL, -- 0.0-1.0
    scored_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (marketplace_asset_id) REFERENCES marketplace_assets(id) ON DELETE CASCADE,
    UNIQUE(marketplace_asset_id, project_hash)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_scores_asset ON marketplace_scores(marketplace_asset_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_scores_project ON marketplace_scores(project_hash);

-- Add marketplace columns to assets table
ALTER TABLE assets ADD COLUMN marketplace_id TEXT;
ALTER TABLE assets ADD COLUMN marketplace_url TEXT;

CREATE INDEX IF NOT EXISTS idx_assets_marketplace_id ON assets(marketplace_id);
