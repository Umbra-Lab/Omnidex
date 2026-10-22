-- Library Health: per-scan record of what the scanner could not index.
-- Rows are replaced per (scan_location_id, kind) on every scan, so the table
-- always reflects the most recent scan of each location rather than growing.

CREATE TABLE IF NOT EXISTS scan_diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_location_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (scan_location_id) REFERENCES scan_locations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scan_diagnostics_location_kind
    ON scan_diagnostics(scan_location_id, kind);
CREATE INDEX IF NOT EXISTS idx_scan_diagnostics_kind
    ON scan_diagnostics(kind);
