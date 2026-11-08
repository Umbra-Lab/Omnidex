ALTER TABLE scan_locations ADD COLUMN scan_mode TEXT NOT NULL DEFAULT 'packs';
ALTER TABLE assets ADD COLUMN scan_search_text TEXT;
DROP TRIGGER IF EXISTS assets_fts_ai;
DROP TRIGGER IF EXISTS assets_fts_ad;
DROP TRIGGER IF EXISTS assets_fts_au;
DROP TABLE assets_fts;
CREATE VIRTUAL TABLE assets_fts USING fts5(name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text, content='assets', content_rowid='id', tokenize='porter unicode61');
INSERT INTO assets_fts(assets_fts) VALUES('rebuild');
CREATE TRIGGER assets_fts_ai AFTER INSERT ON assets BEGIN
 INSERT INTO assets_fts(rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text) VALUES(new.id, COALESCE(new.name, ''), COALESCE(new.description, ''), COALESCE(new.tags, ''), COALESCE(new.orbital_title, ''), COALESCE(new.orbital_description, ''), COALESCE(new.orbital_seller_name, ''), COALESCE(new.scan_search_text, ''));
END;
CREATE TRIGGER assets_fts_ad AFTER DELETE ON assets BEGIN
 INSERT INTO assets_fts(assets_fts, rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text) VALUES('delete', old.id, COALESCE(old.name, ''), COALESCE(old.description, ''), COALESCE(old.tags, ''), COALESCE(old.orbital_title, ''), COALESCE(old.orbital_description, ''), COALESCE(old.orbital_seller_name, ''), COALESCE(old.scan_search_text, ''));
END;
CREATE TRIGGER assets_fts_au AFTER UPDATE ON assets BEGIN
 INSERT INTO assets_fts(assets_fts, rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text) VALUES('delete', old.id, COALESCE(old.name, ''), COALESCE(old.description, ''), COALESCE(old.tags, ''), COALESCE(old.orbital_title, ''), COALESCE(old.orbital_description, ''), COALESCE(old.orbital_seller_name, ''), COALESCE(old.scan_search_text, ''));
 INSERT INTO assets_fts(rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text) VALUES(new.id, COALESCE(new.name, ''), COALESCE(new.description, ''), COALESCE(new.tags, ''), COALESCE(new.orbital_title, ''), COALESCE(new.orbital_description, ''), COALESCE(new.orbital_seller_name, ''), COALESCE(new.scan_search_text, ''));
END;
