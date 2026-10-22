import type { AssetFilter } from '@omnidex/types/db';
import { formatTaxonomyLabel } from '@/lib/format';

/**
 * Sidebar facets, as a set rather than a single selection.
 *
 * The sidebar always offered several ways to slice the library — favorites, FAB
 * ownership, marketplace-match state, ecosystem, category — but only one could
 * be active, so "unmatched Blender props" was three separate questions the user
 * had to ask in sequence and hold the answers to in their head. The backend was
 * never the constraint: every clause in `buildAssetQuery` is AND-joined, and
 * `AssetFilter` has carried independent fields for each axis the whole time.
 * The one-at-a-time behaviour lived entirely in the renderer holding a single
 * `source` string.
 *
 * So facets compose. What is active also has to be *visible* — an intersection
 * of four things that only shows as highlighted sidebar rows is a filter the
 * user forgets they applied and then reads an empty grid as a broken library.
 * `activeFacets` feeds the chip row for exactly that.
 */

export type FacetAxis = 'favorites' | 'fab' | 'category' | 'ecosystem' | 'match';

export interface Facet {
  /** The sidebar key, unchanged — chips remove by the same token they were built from. */
  readonly key: string;
  readonly axis: FacetAxis;
  /** Human label for the chip. Axis-prefixed where the bare value is ambiguous. */
  readonly label: string;
}

/** The "no facets" key. Selecting it is how you clear, so it is never in the set. */
export const ALL_KEY = 'all';

const MATCH_LABELS: Readonly<Record<string, string>> = {
  orbital: 'Orbital matched',
  unmatched: 'Unmatched',
};

function axisOf(key: string): FacetAxis | null {
  if (key === 'favorites' || key === 'fab') return key;
  const axis = key.slice(0, key.indexOf(':'));
  return axis === 'category' || axis === 'ecosystem' || axis === 'match' ? axis : null;
}

function facetValue(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

/**
 * Toggle one sidebar key within the active set.
 *
 * Selecting a second value on an axis *replaces* the first rather than adding
 * to it. That is forced for `match` — orbital and unmatched are complements, so
 * holding both would always return zero rows — and for the rest it is the
 * schema: `AssetFilter.category` and `.ecosystem` are single strings, and the
 * SQL matches one value each.
 *
 * ponytail: within-axis OR ("Props or Environments") would need those fields to
 * become arrays, `buildAssetQuery` to emit an IN / OR-of-EXISTS, and the counts
 * beside each row to become conditional on the rest of the set. Cross-axis
 * intersection is the finding; do the array work only if someone asks for it.
 */
export function toggleFacet(active: ReadonlySet<string>, key: string): Set<string> {
  if (key === ALL_KEY) return new Set();
  const next = new Set(active);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  const axis = axisOf(key);
  if (axis) for (const k of next) if (axisOf(k) === axis) next.delete(k);
  next.add(key);
  return next;
}

/** Fold the active set into the filter the list/count procedures take. */
export function buildAssetFilter(active: ReadonlySet<string>): AssetFilter {
  const filter: AssetFilter = {
    asset_type: null,
    tags: null,
    // Full-text search is served by `assets.search` (FTS5/BM25), not this LIKE
    // path; the field stays as a backend fallback but the UI never drives it.
    name_search: null,
    is_favorite: null,
    scan_location_id: null,
    date_range: null,
    category: null,
    ecosystem: null,
    match_status: null,
  };
  for (const key of active) {
    if (key === 'favorites') filter.is_favorite = true;
    // -1 is the FAB-vault sentinel, the same one `marketplaceSourceCounts` uses.
    else if (key === 'fab') filter.scan_location_id = -1;
    else if (key.startsWith('category:')) filter.category = facetValue(key);
    else if (key.startsWith('ecosystem:')) filter.ecosystem = facetValue(key);
    else if (key === 'match:orbital') filter.match_status = 'orbital';
    else if (key === 'match:unmatched') filter.match_status = 'unmatched';
  }
  return filter;
}

/**
 * Chip descriptors for the active set, in a stable axis order so a chip does
 * not jump position when an unrelated one is removed.
 */
const AXIS_ORDER: readonly FacetAxis[] = ['favorites', 'fab', 'match', 'ecosystem', 'category'];

export function activeFacets(active: ReadonlySet<string>): Facet[] {
  const facets: Facet[] = [];
  for (const key of active) {
    const axis = axisOf(key);
    if (!axis) continue;
    facets.push({ key, axis, label: labelFor(axis, key) });
  }
  return facets.sort((a, b) => AXIS_ORDER.indexOf(a.axis) - AXIS_ORDER.indexOf(b.axis));
}

function labelFor(axis: FacetAxis, key: string): string {
  if (axis === 'favorites') return 'Favorites';
  if (axis === 'fab') return 'FAB library';
  if (axis === 'match')
    return MATCH_LABELS[facetValue(key)] ?? formatTaxonomyLabel(facetValue(key));
  // A bare "Blender" chip could be either axis, and the two answer different
  // questions ("built for" vs "is a"), so the chip says which.
  const prefix = axis === 'ecosystem' ? 'Ecosystem' : 'Category';
  return `${prefix}: ${formatTaxonomyLabel(facetValue(key))}`;
}
