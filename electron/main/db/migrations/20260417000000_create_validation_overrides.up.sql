-- Phase 13: Validation Pre-Flight — validation_overrides table (D-11)

CREATE TABLE IF NOT EXISTS validation_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    override_reason TEXT NOT NULL,
    overridden_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(asset_id, project_id),
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_validation_overrides_asset_id
    ON validation_overrides(asset_id);
CREATE INDEX IF NOT EXISTS idx_validation_overrides_project_id
    ON validation_overrides(project_id);
