-- Add FAB Scan Location
-- Migration: add_fab_scan_location
-- Date: 2025-10-16
--
-- Creates a special scan location with ID -1 for FAB (Epic Games Launcher) assets.
-- This allows FAB assets to use scan_location_id = -1 without violating foreign key constraints.

-- Insert special FAB scan location with ID -1
INSERT OR IGNORE INTO scan_locations (id, name, path, is_active, scan_recursive, created_date, description)
VALUES (
    -1,
    'FAB (Epic Games Launcher)',
    'FAB:VaultCache',
    1,
    0,
    datetime('now'),
    'Assets from Epic Games Launcher VaultCache - automatically synchronized'
);
