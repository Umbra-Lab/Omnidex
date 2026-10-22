-- Normalize Asset Schema Migration
-- Epic 21: Schema Normalization
-- Story 21.1: Create Normalized Schema Migration
--
-- This migration creates a normalized 3-table structure:
-- 1. assets_v2 - Core asset data (~20 fields)
-- 2. asset_marketplace_matches - Marketplace matching layer (marketplace-agnostic)
-- 3. orbital_metadata - Orbital-specific cached metadata
-- 4. fab_metadata - FAB-specific metadata (stub for future)
--
-- The original 'assets' table is preserved for backward compatibility.
-- Data migration is handled separately in Story 21.3.

-- ============================================================================
-- Table 1: assets_v2 - Core asset data
-- ============================================================================
CREATE TABLE IF NOT EXISTS assets_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Core identification
    name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    asset_type TEXT NOT NULL DEFAULT 'unknown',
    file_size INTEGER NOT NULL DEFAULT 0,

    -- Timestamps
    created_date TEXT NOT NULL DEFAULT (datetime('now')),
    modified_date TEXT NOT NULL DEFAULT (datetime('now')),
    first_indexed_timestamp TEXT DEFAULT (datetime('now')),
    last_accessed TEXT,

    -- Location reference
    scan_location_id INTEGER NOT NULL,

    -- User metadata
    is_favorite BOOLEAN NOT NULL DEFAULT 0,
    tags TEXT,              -- JSON array of tags
    description TEXT,       -- User description
    notes TEXT,             -- User notes

    -- Technical metadata (from file analysis)
    file_hash TEXT,
    metadata TEXT,          -- JSON for additional structured metadata

    -- Thumbnail
    thumbnail_path TEXT,
    has_local_thumbnail BOOLEAN NOT NULL DEFAULT 0,

    -- Search optimization (denormalized for Tantivy)
    search_text TEXT,

    FOREIGN KEY (scan_location_id) REFERENCES scan_locations(id) ON DELETE CASCADE
);

-- ============================================================================
-- Table 2: asset_marketplace_matches - Marketplace matching layer
-- ============================================================================
-- Marketplace-agnostic design supporting multiple marketplaces (Orbital, FAB, Epic)
CREATE TABLE IF NOT EXISTS asset_marketplace_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,

    -- Marketplace identification
    marketplace TEXT NOT NULL,          -- 'orbital', 'fab', 'epic'
    product_slug TEXT,                  -- Marketplace-specific product identifier
    fab_id TEXT,                        -- FAB UUID for direct API lookups

    -- Match quality
    match_confidence REAL NOT NULL DEFAULT 0.0,
    match_source TEXT,                  -- 'auto', 'manual', 'api', 'exact', 'high'
    verified BOOLEAN NOT NULL DEFAULT 0,

    -- User overrides
    manual_overrides TEXT,              -- JSON for manual edits

    -- Timestamps
    matched_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_verified_at TEXT,

    UNIQUE(asset_id, marketplace),
    FOREIGN KEY (asset_id) REFERENCES assets_v2(id) ON DELETE CASCADE
);

-- ============================================================================
-- Table 3: orbital_metadata - Orbital Market specific data
-- ============================================================================
-- Cached metadata from Orbital Market API responses
CREATE TABLE IF NOT EXISTS orbital_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL UNIQUE,

    -- Product information
    title TEXT,
    description TEXT,
    technical_details TEXT,

    -- Seller information
    seller_name TEXT,

    -- Pricing
    price REAL,
    currency TEXT DEFAULT 'USD',

    -- URLs
    thumbnail_url TEXT,
    source_url TEXT,         -- Product page URL
    gallery_images TEXT,     -- JSON array of image URLs

    -- Ratings
    rating_average REAL,
    rating_count INTEGER,

    -- Categories and compatibility
    categories TEXT,              -- JSON array
    supported_versions TEXT,      -- JSON array (UE versions)

    -- Timestamps
    release_date TEXT,
    last_modified TEXT,           -- When product was last updated on Orbital
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked_timestamp TEXT,  -- When we last checked for updates

    -- Raw API response for debugging/recovery
    raw_json TEXT,

    FOREIGN KEY (match_id) REFERENCES asset_marketplace_matches(id) ON DELETE CASCADE
);

-- ============================================================================
-- Table 4: fab_metadata - FAB Marketplace specific data (stub)
-- ============================================================================
-- Placeholder for future FAB API integration
CREATE TABLE IF NOT EXISTS fab_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL UNIQUE,

    -- Basic product info
    title TEXT,
    description TEXT,
    owner_name TEXT,

    -- Pricing
    price REAL,
    currency TEXT DEFAULT 'USD',

    -- URLs
    thumbnail_url TEXT,
    product_url TEXT,

    -- Timestamps
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- Raw API response
    raw_json TEXT,

    FOREIGN KEY (match_id) REFERENCES asset_marketplace_matches(id) ON DELETE CASCADE
);

-- ============================================================================
-- Indexes for query performance
-- ============================================================================

-- assets_v2 indexes
CREATE INDEX IF NOT EXISTS idx_assets_v2_name ON assets_v2(name);
CREATE INDEX IF NOT EXISTS idx_assets_v2_file_path ON assets_v2(file_path);
CREATE INDEX IF NOT EXISTS idx_assets_v2_scan_location ON assets_v2(scan_location_id);
CREATE INDEX IF NOT EXISTS idx_assets_v2_asset_type ON assets_v2(asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_v2_favorite ON assets_v2(is_favorite);
CREATE INDEX IF NOT EXISTS idx_assets_v2_file_hash ON assets_v2(file_hash);
CREATE INDEX IF NOT EXISTS idx_assets_v2_local_thumbnail ON assets_v2(has_local_thumbnail);

-- asset_marketplace_matches indexes
CREATE INDEX IF NOT EXISTS idx_matches_asset_id ON asset_marketplace_matches(asset_id);
CREATE INDEX IF NOT EXISTS idx_matches_marketplace ON asset_marketplace_matches(marketplace);
CREATE INDEX IF NOT EXISTS idx_matches_product_slug ON asset_marketplace_matches(product_slug);
CREATE INDEX IF NOT EXISTS idx_matches_fab_id ON asset_marketplace_matches(fab_id);
CREATE INDEX IF NOT EXISTS idx_matches_confidence ON asset_marketplace_matches(match_confidence);
CREATE INDEX IF NOT EXISTS idx_matches_verified ON asset_marketplace_matches(verified);

-- orbital_metadata indexes
CREATE INDEX IF NOT EXISTS idx_orbital_match_id ON orbital_metadata(match_id);
CREATE INDEX IF NOT EXISTS idx_orbital_seller ON orbital_metadata(seller_name);
CREATE INDEX IF NOT EXISTS idx_orbital_rating ON orbital_metadata(rating_average);

-- fab_metadata indexes
CREATE INDEX IF NOT EXISTS idx_fab_match_id ON fab_metadata(match_id);
