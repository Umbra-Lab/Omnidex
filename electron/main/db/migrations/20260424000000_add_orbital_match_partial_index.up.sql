-- WS6 / Track 1: partial index backing the Orbital-source count and the
-- "unmatched" category bucket.
--
-- `marketplaceSourceCounts` now derives the `orbital` count from
-- `matched_orbital_product_slug IS NOT NULL AND content_format IS NULL`, and
-- `listAssetsByCategory('unmatched')` filters on `matched_orbital_product_slug
-- IS NULL`. A partial index over the matched, non-Learn rows lets both skip a
-- full table scan. Matches the existing partial-index style
-- (`idx_marketplace_matches_verified`). IF NOT EXISTS keeps it idempotent.
CREATE INDEX IF NOT EXISTS idx_assets_orbital_matched
ON assets(matched_orbital_product_slug)
WHERE matched_orbital_product_slug IS NOT NULL AND content_format IS NULL;
