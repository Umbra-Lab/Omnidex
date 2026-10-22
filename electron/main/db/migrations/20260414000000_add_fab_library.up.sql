-- Add FAB library ownership tracking
--
-- Quick task 260414-vg5: Read Epic Games Launcher's listings_v1.db and expose
-- FAB ownership to Omnidex so users can filter, badge, and trigger downloads.

ALTER TABLE assets ADD COLUMN fab_owned BOOLEAN NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_assets_fab_owned ON assets(fab_owned);

CREATE TABLE IF NOT EXISTS fab_library_items (
    listing_uid TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    thumbnail TEXT,
    user_seller_name TEXT,
    category_name TEXT,
    namespace TEXT,
    is_downloaded INTEGER NOT NULL DEFAULT 0,
    local_path TEXT,
    cache_size INTEGER,
    synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fab_library_downloaded ON fab_library_items(is_downloaded);
