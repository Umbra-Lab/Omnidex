-- Create asset_tags table for AI-generated and user tags
-- Supports Story 1.2: AI Tag Extraction from Asset Descriptions

CREATE TABLE IF NOT EXISTS asset_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    tag_type TEXT CHECK(tag_type IN ('genre', 'mechanics', 'art_style', 'technical', 'use_case')) NOT NULL,
    confidence REAL CHECK(confidence >= 0.0 AND confidence <= 1.0),
    source TEXT CHECK(source IN ('ai', 'official', 'user')) NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- Create indexes for optimal query performance
CREATE INDEX IF NOT EXISTS idx_asset_tags_asset_id ON asset_tags(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag_type ON asset_tags(tag_type);
CREATE INDEX IF NOT EXISTS idx_asset_tags_source ON asset_tags(source);

-- Unique constraint to prevent duplicate tags from the same source for an asset
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_tags_unique ON asset_tags(asset_id, tag, source);

-- Create batch_state table for tracking batch tagging progress
CREATE TABLE IF NOT EXISTS batch_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_running BOOLEAN NOT NULL DEFAULT 0,
    last_processed_asset_id INTEGER,
    total_assets INTEGER DEFAULT 0,
    processed_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    started_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Initialize batch_state with single row
INSERT OR IGNORE INTO batch_state (id, is_running) VALUES (1, 0);
