-- Prevent duplicate assets from concurrent scans (TOCTOU race condition fix)
-- First, remove any existing duplicates (keep the one with the lowest id)
DELETE FROM assets WHERE id NOT IN (
    SELECT MIN(id) FROM assets GROUP BY scan_location_id, file_path
);

-- Add unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_unique_path
ON assets(scan_location_id, file_path);
