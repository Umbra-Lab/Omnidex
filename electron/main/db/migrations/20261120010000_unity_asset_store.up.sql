-- Asset Store identity read from a .unitypackage's own gzip header (no network).
-- NULL for packages that were exported by hand rather than downloaded from the store.
ALTER TABLE unity_packages ADD COLUMN store_id TEXT;
ALTER TABLE unity_packages ADD COLUMN store_title TEXT;
ALTER TABLE unity_packages ADD COLUMN store_publisher TEXT;
ALTER TABLE unity_packages ADD COLUMN store_category TEXT;
ALTER TABLE unity_packages ADD COLUMN store_version TEXT;
ALTER TABLE unity_packages ADD COLUMN store_unity_version TEXT;
ALTER TABLE unity_packages ADD COLUMN store_published_on TEXT;
CREATE INDEX idx_unity_packages_store_id ON unity_packages(store_id);
