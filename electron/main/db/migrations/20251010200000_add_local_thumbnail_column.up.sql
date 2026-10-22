-- Add has_local_thumbnail column to assets table
-- Part of Epic 2: Enhanced Metadata Extraction (Story 2.1)

ALTER TABLE assets ADD COLUMN has_local_thumbnail BOOLEAN NOT NULL DEFAULT 0;

-- Create index for faster filtering by local thumbnail availability
CREATE INDEX IF NOT EXISTS idx_assets_local_thumbnail ON assets(has_local_thumbnail);
