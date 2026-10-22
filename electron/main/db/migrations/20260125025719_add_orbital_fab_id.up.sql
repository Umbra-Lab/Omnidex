-- Add orbital_fab_id column to store FAB Marketplace UUID
-- This UUID can be used for direct product lookups via /api/products/product/{fab_id}
ALTER TABLE assets ADD COLUMN orbital_fab_id TEXT;

-- Create index for faster lookups by fab_id
CREATE INDEX IF NOT EXISTS idx_assets_orbital_fab_id ON assets(orbital_fab_id);
