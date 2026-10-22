-- Phase 12: Project Workspace — Projects and asset project tags schema

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ue5_content_path TEXT NOT NULL DEFAULT '',
    visual_brief_keywords TEXT NOT NULL DEFAULT '',
    budget_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS asset_project_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'considering'
        CHECK(status IN ('considering', 'in_use')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, asset_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_asset_project_tags_project_id ON asset_project_tags(project_id);
CREATE INDEX IF NOT EXISTS idx_asset_project_tags_asset_id ON asset_project_tags(asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_project_tags_status ON asset_project_tags(status);

CREATE TRIGGER IF NOT EXISTS update_projects_timestamp
AFTER UPDATE ON projects
FOR EACH ROW
BEGIN
    UPDATE projects SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS update_project_tag_timestamp
AFTER UPDATE ON asset_project_tags
FOR EACH ROW
BEGIN
    UPDATE asset_project_tags SET updated_at = datetime('now') WHERE id = OLD.id;
END;
