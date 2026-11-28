export const ORBITAL_CANDIDATES_SQL = `SELECT id, name, orbital_title FROM assets
 WHERE content_format IS NULL AND scan_location_id > 0
   AND asset_type NOT GLOB 'dcc_*'
   AND (((orbital_description IS NULL OR orbital_description = '') AND orbital_match_attempted = 0)
        OR orbital_description LIKE '{%')
   -- "Nothing on Orbital is this pack" (Match view dismiss) holds for the
   -- bulk run too: never auto-match an asset the user took out of the queue.
   AND NOT EXISTS (SELECT 1 FROM orbital_match_rejections r
                    WHERE r.asset_id = assets.id AND r.product_slug IS NULL)
 ORDER BY id`;
