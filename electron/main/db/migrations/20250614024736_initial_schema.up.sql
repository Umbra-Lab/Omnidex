-- Add up migration script here

-- Initial schema for Omnidex database
-- Migrated from create_tables function

-- Create scan_locations table
CREATE TABLE IF NOT EXISTS scan_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    last_scan TEXT,
    scan_recursive BOOLEAN NOT NULL DEFAULT 0,
    file_extensions TEXT,
    created_date TEXT NOT NULL,
    description TEXT
);

-- Create assets table with all columns including Orbital metadata
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    asset_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_date TEXT NOT NULL,
    modified_date TEXT NOT NULL,
    first_indexed_timestamp TEXT,
    thumbnail_path TEXT,
    tags TEXT,
    description TEXT,
    scan_location_id INTEGER NOT NULL,
    is_favorite BOOLEAN NOT NULL DEFAULT 0,
    last_accessed TEXT,
    file_hash TEXT,
    metadata TEXT,

    -- Orbital metadata
    orbital_title TEXT,
    orbital_description TEXT,
    orbital_technical_details TEXT,
    orbital_seller_name TEXT,
    orbital_price REAL,
    orbital_release_date TEXT,
    orbital_last_modified TEXT,
    orbital_rating_average REAL,
    orbital_rating_count INTEGER,
    orbital_categories TEXT,
    orbital_supported_versions TEXT,
    orbital_gallery_images TEXT,
    orbital_thumbnail_url TEXT,
    orbital_source_url TEXT,
    orbital_raw_json TEXT,
    orbital_last_checked_timestamp TEXT,

    -- Matching information
    matched_orbital_product_slug TEXT,
    orbital_match_confidence REAL,
    orbital_match_type TEXT,

    -- User additions
    notes TEXT,
    orbital_manual_overrides TEXT,

    FOREIGN KEY (scan_location_id) REFERENCES scan_locations(id) ON DELETE CASCADE
);

-- Create app_settings table
CREATE TABLE IF NOT EXISTS app_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    setting_type TEXT NOT NULL,
    description TEXT,
    created_date TEXT NOT NULL,
    modified_date TEXT NOT NULL
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_location ON assets(scan_location_id);
CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(is_favorite);
CREATE INDEX IF NOT EXISTS idx_assets_file_hash ON assets(file_hash);
