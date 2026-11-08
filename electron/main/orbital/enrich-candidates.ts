export const ORBITAL_CANDIDATES_SQL = `SELECT id, name, orbital_title FROM assets
 WHERE content_format IS NULL AND scan_location_id > 0
   AND asset_type NOT GLOB 'dcc_*'
   AND (((orbital_description IS NULL OR orbital_description = '') AND orbital_match_attempted = 0)
        OR orbital_description LIKE '{%')
 ORDER BY id`;
