-- Search keywords written by the enrich-tags job (Claude, on the user's own
-- subscription): what a pack contains, its setting and style, and common
-- synonyms that its name does not say. Kept apart from the user's own `tags`
-- so it can be ranked lower, cleared, or regenerated without touching them.
-- NULL means never tagged; '' means tagged and nothing came back.
ALTER TABLE assets ADD COLUMN ai_tags TEXT;
ALTER TABLE assets ADD COLUMN ai_tagged_at TEXT;

DROP TRIGGER IF EXISTS assets_fts_ai;
DROP TRIGGER IF EXISTS assets_fts_ad;
DROP TRIGGER IF EXISTS assets_fts_au;
DROP TABLE assets_fts;
CREATE VIRTUAL TABLE assets_fts USING fts5(name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text, ai_tags, content='assets', content_rowid='id', tokenize='porter unicode61');
INSERT INTO assets_fts(assets_fts) VALUES('rebuild');
CREATE TRIGGER assets_fts_ai AFTER INSERT ON assets BEGIN
 INSERT INTO assets_fts(rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text, ai_tags) VALUES(new.id, COALESCE(new.name, ''), COALESCE(new.description, ''), COALESCE(new.tags, ''), COALESCE(new.orbital_title, ''), COALESCE(new.orbital_description, ''), COALESCE(new.orbital_seller_name, ''), COALESCE(new.scan_search_text, ''), COALESCE(new.ai_tags, ''));
END;
CREATE TRIGGER assets_fts_ad AFTER DELETE ON assets BEGIN
 INSERT INTO assets_fts(assets_fts, rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text, ai_tags) VALUES('delete', old.id, COALESCE(old.name, ''), COALESCE(old.description, ''), COALESCE(old.tags, ''), COALESCE(old.orbital_title, ''), COALESCE(old.orbital_description, ''), COALESCE(old.orbital_seller_name, ''), COALESCE(old.scan_search_text, ''), COALESCE(old.ai_tags, ''));
END;
CREATE TRIGGER assets_fts_au AFTER UPDATE ON assets BEGIN
 INSERT INTO assets_fts(assets_fts, rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text, ai_tags) VALUES('delete', old.id, COALESCE(old.name, ''), COALESCE(old.description, ''), COALESCE(old.tags, ''), COALESCE(old.orbital_title, ''), COALESCE(old.orbital_description, ''), COALESCE(old.orbital_seller_name, ''), COALESCE(old.scan_search_text, ''), COALESCE(old.ai_tags, ''));
 INSERT INTO assets_fts(rowid, name, description, tags, orbital_title, orbital_description, orbital_seller_name, scan_search_text, ai_tags) VALUES(new.id, COALESCE(new.name, ''), COALESCE(new.description, ''), COALESCE(new.tags, ''), COALESCE(new.orbital_title, ''), COALESCE(new.orbital_description, ''), COALESCE(new.orbital_seller_name, ''), COALESCE(new.scan_search_text, ''), COALESCE(new.ai_tags, ''));
END;
