-- Phase 14: Promotion Pipeline — append-only promotion history (D-08)
-- Ships in the same commit as the atomic-copy command per STATE.md:
-- "PROM-05 (history log) must ship in the same commit as PROM-03 (atomic copy)
-- — undo cannot be retrofitted".

CREATE TABLE IF NOT EXISTS promotion_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    asset_id INTEGER NOT NULL,
    status TEXT NOT NULL
        CHECK(status IN ('succeeded', 'failed', 'undone')),
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    p4_status TEXT
        CHECK(p4_status IS NULL OR p4_status IN ('added', 'failed', 'retried', 'not_attempted')),
    p4_changelist INTEGER,
    manifest_snapshot_json TEXT,
    error_message TEXT,
    undoes_history_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
    FOREIGN KEY (undoes_history_id) REFERENCES promotion_history(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_promotion_history_project_id
    ON promotion_history(project_id);
CREATE INDEX IF NOT EXISTS idx_promotion_history_asset_id
    ON promotion_history(asset_id);
CREATE INDEX IF NOT EXISTS idx_promotion_history_batch_id
    ON promotion_history(batch_id);
CREATE INDEX IF NOT EXISTS idx_promotion_history_status
    ON promotion_history(status);
CREATE INDEX IF NOT EXISTS idx_promotion_history_undoes
    ON promotion_history(undoes_history_id);
CREATE INDEX IF NOT EXISTS idx_promotion_history_created_at
    ON promotion_history(created_at DESC);

-- NO update trigger — the table is append-only by contract.
-- The ONLY allowed UPDATE is to p4_status (+ p4_changelist) per D-14,
-- enforced at the repository layer, not by a trigger.
