-- Electron-only migration (no SQLx counterpart). Replaces the Tantivy mmap
-- index maintained by `src-tauri/src/search_manager.rs` with SQLite FTS5.
-- BM25 ranking is weighted per the plan: name (10), tags (5), description (1).
--
-- This migration lives only in electron/main/db/migrations/ — the Tauri path
-- continues to rebuild Tantivy on its own schedule until Phase 4 retires it.

CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
    name,
    description,
    tags,
    orbital_title,
    orbital_description,
    orbital_seller_name,
    content='assets',
    content_rowid='id',
    tokenize='porter unicode61'
);

-- Backfill the index from the current assets snapshot. No-op on fresh install.
INSERT INTO assets_fts (
    rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name
)
SELECT
    id,
    COALESCE(name, ''),
    COALESCE(description, ''),
    COALESCE(tags, ''),
    COALESCE(orbital_title, ''),
    COALESCE(orbital_description, ''),
    COALESCE(orbital_seller_name, '')
FROM assets;

-- Keep the index in sync with the source table.
CREATE TRIGGER IF NOT EXISTS assets_fts_ai AFTER INSERT ON assets BEGIN
    INSERT INTO assets_fts (
        rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name
    ) VALUES (
        new.id,
        COALESCE(new.name, ''),
        COALESCE(new.description, ''),
        COALESCE(new.tags, ''),
        COALESCE(new.orbital_title, ''),
        COALESCE(new.orbital_description, ''),
        COALESCE(new.orbital_seller_name, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS assets_fts_ad AFTER DELETE ON assets BEGIN
    INSERT INTO assets_fts (
        assets_fts, rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name
    ) VALUES (
        'delete',
        old.id,
        COALESCE(old.name, ''),
        COALESCE(old.description, ''),
        COALESCE(old.tags, ''),
        COALESCE(old.orbital_title, ''),
        COALESCE(old.orbital_description, ''),
        COALESCE(old.orbital_seller_name, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS assets_fts_au AFTER UPDATE ON assets BEGIN
    INSERT INTO assets_fts (
        assets_fts, rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name
    ) VALUES (
        'delete',
        old.id,
        COALESCE(old.name, ''),
        COALESCE(old.description, ''),
        COALESCE(old.tags, ''),
        COALESCE(old.orbital_title, ''),
        COALESCE(old.orbital_description, ''),
        COALESCE(old.orbital_seller_name, '')
    );
    INSERT INTO assets_fts (
        rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name
    ) VALUES (
        new.id,
        COALESCE(new.name, ''),
        COALESCE(new.description, ''),
        COALESCE(new.tags, ''),
        COALESCE(new.orbital_title, ''),
        COALESCE(new.orbital_description, ''),
        COALESCE(new.orbital_seller_name, '')
    );
END;
