-- Add FAB assets table for Epic Games Launcher VaultCache integration
-- Migration: add_fab_assets_table
-- Date: 2025-10-10

-- FAB assets table stores metadata from Epic Games Launcher VaultCache
CREATE TABLE IF NOT EXISTS fab_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fab_item_id TEXT UNIQUE,              -- FAB marketplace catalog item ID (UUID)
    fab_namespace TEXT,                   -- FAB marketplace namespace
    name TEXT NOT NULL,                   -- Asset display name
    version TEXT,                         -- Build version (e.g., "1.0.0")
    vault_directory TEXT,                 -- Path to VaultCache directory
    total_size INTEGER,                   -- Total asset size in bytes
    thumbnail_path TEXT,                  -- Path to local thumbnail image
    last_synced TEXT,                     -- Last sync timestamp (ISO 8601)
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_fab_item_id ON fab_assets(fab_item_id);
CREATE INDEX IF NOT EXISTS idx_fab_namespace ON fab_assets(fab_namespace);
CREATE INDEX IF NOT EXISTS idx_fab_sync ON fab_assets(last_synced);

-- Optional: Link FAB assets to main assets table if needed
-- This allows cross-referencing between scanned local assets and FAB library
ALTER TABLE assets ADD COLUMN fab_item_id TEXT;
CREATE INDEX IF NOT EXISTS idx_assets_fab_item_id ON assets(fab_item_id);
