-- Unity projects and .unitypackage files, read from disk without the Editor.
-- One `assets` row stands for each project or package; these tables hold what is inside it.
-- scan_locations.scan_mode gains the value 'unity' (the column has no CHECK).

CREATE TABLE unity_projects (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  editor_version TEXT,
  render_pipeline TEXT NOT NULL DEFAULT 'built-in',
  packages_json TEXT NOT NULL DEFAULT '{}',
  scanned_at TEXT NOT NULL
);

CREATE TABLE unity_packages (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  file_size INTEGER NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  scanned_at TEXT NOT NULL
);

-- Every file inside a project's Assets/ (or inside a package), keyed by its GUID.
CREATE TABLE unity_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  guid TEXT,
  rel_path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  serialization TEXT NOT NULL DEFAULT 'none' CHECK (serialization IN ('text', 'binary', 'none')),
  -- Prefab variant parent GUID, when this is a prefab variant.
  variant_of TEXT,
  -- JSON: scene/prefab outline (root objects, component counts, scripts used).
  summary_json TEXT,
  UNIQUE (container_id, rel_path)
);
CREATE INDEX idx_unity_assets_guid ON unity_assets(guid);
CREATE INDEX idx_unity_assets_kind ON unity_assets(container_id, kind);

-- A GUID reference found in a text-serialized asset: from_guid uses to_guid.
CREATE TABLE unity_refs (
  container_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  from_guid TEXT NOT NULL,
  to_guid TEXT NOT NULL,
  PRIMARY KEY (container_id, from_guid, to_guid)
) WITHOUT ROWID;
CREATE INDEX idx_unity_refs_to ON unity_refs(container_id, to_guid);
