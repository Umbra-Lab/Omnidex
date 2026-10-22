-- Decisions the user made in the Match queue, so they survive a reload.
--
-- Before this the queue's only memory was a Set in a React component: skipping
-- a pack hid it until the next render of that view and no longer. Reopening
-- Match re-offered the same wrong candidate for the same pack, forever.
--
-- One nullable column carries two different verbs, because they are answers to
-- different questions and neither can be derived from the other:
--
--   product_slug IS NOT NULL  "this listing is not this pack"
--                             The asset stays in the queue; only that one
--                             candidate stops being offered.
--
--   product_slug IS NULL      "nothing on Orbital is this pack"
--                             The asset leaves the queue entirely.
--
-- Asset-level dismissal is NOT "reject every slug" — the catalog is unbounded,
-- so it cannot be expressed as a set of pair rows.
CREATE TABLE IF NOT EXISTS orbital_match_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    product_slug TEXT,
    rejected_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- COALESCE rather than a plain UNIQUE(asset_id, product_slug): SQLite treats
-- NULLs as distinct in a unique index, so the plain form would cheerfully store
-- the same asset dismissed five times.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orbital_match_rejections_unique
    ON orbital_match_rejections(asset_id, COALESCE(product_slug, ''));
