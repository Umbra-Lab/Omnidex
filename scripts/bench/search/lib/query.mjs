// Single source of truth for the FTS5 search the app runs, mirrored 1:1 from
// electron/main/db/repos/assets.ts so the benchmark measures the real query —
// not an approximation of it.
//
//   - buildFtsQuery        == assets.ts buildFtsQuery (per-token "phrase"* )
//   - CARD_COLUMNS         == assets.ts CARD_COLUMNS (projection cost is real)
//   - BM25_WEIGHTS / SQL   == assets.ts searchAssets ORDER BY bm25(...)
//
// FTS column order (from migration 20260423000000_add_fts5_search.up.sql):
//   name, description, tags, orbital_title, orbital_description, orbital_seller_name
// BM25 weights applied in that order:
//   10.0  1.0   5.0   8.0   2.0   2.0
//   name  desc  tags  o_title o_desc o_seller
// => name is weighted 10x description and 2x tags. (Resume "3x name / 2x tag"
//    was wrong on both the multiplier and which field.)

export const BM25_WEIGHTS = [10.0, 1.0, 5.0, 8.0, 2.0, 2.0];

export const FTS_COLUMNS = [
  'name',
  'description',
  'tags',
  'orbital_title',
  'orbital_description',
  'orbital_seller_name',
];

const CARD_COLUMNS = `
  id, name, orbital_title, asset_type, file_size, file_path,
  thumbnail_path, orbital_thumbnail_url,
  orbital_rating_average, orbital_rating_count,
  orbital_price, orbital_source_url, orbital_seller_name,
  is_favorite, created_date, fab_owned,
  tags, orbital_categories
`;

export const DEFAULT_LIMIT = 100;

// Exact SQL from assets.ts searchAssets(), with CARD_COLUMNS qualified.
const qualifiedCards = CARD_COLUMNS.split(',')
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => `assets.${c}`)
  .join(', ');

export const SEARCH_SQL = `
    SELECT ${qualifiedCards}
    FROM assets
    JOIN assets_fts ON assets_fts.rowid = assets.id
    WHERE assets_fts MATCH ?
    ORDER BY bm25(assets_fts, ${BM25_WEIGHTS.map((w) => w.toFixed(1)).join(', ')})
    LIMIT ? OFFSET ?
`;

// Exact buildFtsQuery() from assets.ts: wrap each whitespace token as a quoted
// phrase with a trailing * for prefix matching. `car` -> `"car"*`.
export function buildFtsQuery(raw) {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim().replace(/"/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

// Representative query suite. Every term was verified to return >=1 hit against
// the live 1,276-asset DB (probe: 2026-06-05). The synthetic generator draws
// from the same vocabulary so these hit at 10k/50k scale too.
export const QUERY_SUITE = {
  // Whole-word, single token.
  single: [
    'modular',
    'character',
    'environment',
    'weapon',
    'material',
    'animation',
    'vehicle',
    'foliage',
    'blueprint',
    'system',
  ],
  // Two or three whole-word tokens (AND-ed by FTS).
  multi: [
    'modular building',
    'sci fi weapon',
    'stylized environment',
    'fantasy character',
    'city street prop',
    'procedural foliage system',
  ],
  // Partial words — the per-keystroke autocomplete case the trailing * targets.
  prefix: ['char', 'env', 'weap', 'mat', 'anim', 'veh', 'fol', 'proc'],
};
