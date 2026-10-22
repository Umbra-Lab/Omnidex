-- Epic 3 Story 3.2: Collections/Playlists Database Schema
-- Organize assets into collections for project organization

-- Collections table
CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT DEFAULT '#3b82f6',  -- Hex color for visual distinction
    icon TEXT,                     -- Optional icon identifier
    is_smart BOOLEAN DEFAULT 0,   -- Smart collections use saved filters
    smart_filter TEXT,            -- JSON filter criteria for smart collections
    sort_order INTEGER DEFAULT 0, -- For manual ordering in sidebar
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Junction table for many-to-many relationship
CREATE TABLE IF NOT EXISTS collection_items (
    collection_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    sort_order INTEGER DEFAULT 0,  -- For manual ordering within collection
    PRIMARY KEY (collection_id, asset_id),
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_collections_name ON collections(name);
CREATE INDEX IF NOT EXISTS idx_collections_sort_order ON collections(sort_order);
CREATE INDEX IF NOT EXISTS idx_collection_items_asset_id ON collection_items(asset_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_added_at ON collection_items(added_at);

-- Trigger to update collections.updated_at when items are added/removed
CREATE TRIGGER IF NOT EXISTS update_collection_on_item_insert
AFTER INSERT ON collection_items
FOR EACH ROW
BEGIN
    UPDATE collections SET updated_at = datetime('now') WHERE id = NEW.collection_id;
END;

CREATE TRIGGER IF NOT EXISTS update_collection_on_item_delete
AFTER DELETE ON collection_items
FOR EACH ROW
BEGIN
    UPDATE collections SET updated_at = datetime('now') WHERE id = OLD.collection_id;
END;

-- Trigger to update collections.updated_at on direct modification
CREATE TRIGGER IF NOT EXISTS update_collections_timestamp
AFTER UPDATE ON collections
FOR EACH ROW
BEGIN
    UPDATE collections SET updated_at = datetime('now') WHERE id = OLD.id;
END;
