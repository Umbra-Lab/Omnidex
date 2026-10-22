-- Epic 3 Story 3.1: Notes & Ratings Database Schema
-- User annotations (notes, ratings, reminders) for assets

CREATE TABLE IF NOT EXISTS asset_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    note_text TEXT,
    rating REAL CHECK(rating IS NULL OR (rating >= 0.0 AND rating <= 5.0)),
    tested_ue_versions TEXT,  -- JSON array: ["5.3", "5.4"]
    reminders TEXT,           -- JSON array: ["Check compatibility", "Needs update"]
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- Index for fast lookups by asset_id
CREATE INDEX IF NOT EXISTS idx_asset_notes_asset_id ON asset_notes(asset_id);

-- Index for filtering by rating
CREATE INDEX IF NOT EXISTS idx_asset_notes_rating ON asset_notes(rating) WHERE rating IS NOT NULL;

-- Trigger to update updated_at on modification
CREATE TRIGGER IF NOT EXISTS update_asset_notes_timestamp
AFTER UPDATE ON asset_notes
FOR EACH ROW
BEGIN
    UPDATE asset_notes SET updated_at = datetime('now') WHERE id = OLD.id;
END;
