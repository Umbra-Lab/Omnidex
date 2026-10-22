import { post } from './client';
import type { OrbitalSearchItem, OrbitalSearchRequest } from './models';

/**
 * Orbital returns `price` / `rating.average` / `rating.count` as strings in some
 * responses even though the typed shape says `number`. Coerce them to real
 * numbers once here — the single producer of `OrbitalSearchItem` — so every
 * consumer (matcher Fuse scoring, enrich DB writes, renderer `.toFixed`) gets a
 * number and the `number | null` types are honest. Non-numeric / empty → null.
 */
function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeItem(item: OrbitalSearchItem): OrbitalSearchItem {
  return {
    ...item,
    price: toNum(item.price),
    discount: toNum(item.discount),
    rating: item.rating
      ? { average: toNum(item.rating.average), count: toNum(item.rating.count) }
      : item.rating,
  };
}

/**
 * Search Orbital Market products by free-text query.
 *
 * Hits `POST /api/products/search` with the shape the public frontend uses:
 * `{ searchText, limit, skip, sortField, sortDirection }`. The memory note
 * "Orbital API uses skip not offset" is encoded here — earlier iterations of
 * this code used the wrong param name and silently returned empty arrays.
 */
export async function searchProducts(req: OrbitalSearchRequest): Promise<OrbitalSearchItem[]> {
  const text = req.searchText.trim();
  if (!text) return [];

  const body = {
    searchText: text,
    limit: Math.min(req.limit ?? 20, 40),
    skip: req.skip ?? 0,
    sortField: req.sortField ?? 'popularity',
    sortDirection: req.sortDirection ?? 'desc',
  };

  return post('/api/products/search', body, (raw) => {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as OrbitalSearchItem[]).map(normalizeItem);
  });
}
