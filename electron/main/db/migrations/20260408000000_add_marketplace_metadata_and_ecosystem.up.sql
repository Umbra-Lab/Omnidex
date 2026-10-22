-- Generic marketplace metadata table for non-Orbital, non-FAB providers.
-- Existing orbital_metadata and fab_metadata tables stay for backward compatibility.
-- New providers (Sketchfab, BlenderMarket, FlippedNormals, aescripts, etc.) use this table.
CREATE TABLE IF NOT EXISTS marketplace_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL UNIQUE,

    title TEXT,
    description TEXT,
    technical_details TEXT,
    seller_name TEXT,

    price REAL,
    currency TEXT DEFAULT 'USD',

    thumbnail_url TEXT,
    source_url TEXT,
    gallery_images TEXT,        -- JSON array of image URLs

    rating_average REAL,
    rating_count INTEGER,

    categories TEXT,            -- JSON array
    tags TEXT,                  -- JSON array (separate from categories)
    supported_software TEXT,    -- JSON array e.g. ["Blender 4.x", "ZBrush 2025"]
    file_formats TEXT,          -- JSON array e.g. [".blend", ".fbx", ".obj"]

    release_date TEXT,
    last_modified TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked_timestamp TEXT,

    product_slug TEXT,
    raw_json TEXT,

    FOREIGN KEY (match_id) REFERENCES asset_marketplace_matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mkt_meta_match ON marketplace_metadata(match_id);
CREATE INDEX IF NOT EXISTS idx_mkt_meta_seller ON marketplace_metadata(seller_name);

-- Add ecosystem column to track which software ecosystem each asset belongs to.
-- Defaults to 'unreal_engine' for all existing assets.
ALTER TABLE assets ADD COLUMN ecosystem TEXT DEFAULT 'unreal_engine';
ALTER TABLE assets_v2 ADD COLUMN ecosystem TEXT DEFAULT 'unreal_engine';
