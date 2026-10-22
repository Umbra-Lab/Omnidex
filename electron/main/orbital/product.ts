import { getCachedProduct, putCachedProduct } from './cache';
import { get, OrbitalNotFoundError } from './client';
import type { OrbitalProductDetail } from './models';

interface GetProductOptions {
  /** Skip the cache and force a network fetch. Default: false. */
  bypassCache?: boolean;
}

/**
 * Fetch a single Orbital Market product by slug/id. Returns `null` on 404
 * so callers can distinguish "not found" from transport errors.
 *
 * Cache-first: hits the `orbital_product_cache` table before the network
 * unless `bypassCache` is set. Successful fetches write through to the
 * cache with a 24h TTL.
 */
export async function getProduct(
  slug: string,
  options: GetProductOptions = {},
): Promise<OrbitalProductDetail | null> {
  if (!options.bypassCache) {
    const cached = getCachedProduct(slug);
    if (cached) return cached;
  }

  const started = Date.now();
  try {
    const product = await get(
      `/api/products/product/${encodeURIComponent(slug)}`,
      (raw) => JSON.parse(raw) as OrbitalProductDetail,
    );
    putCachedProduct(slug, product, Date.now() - started);
    return product;
  } catch (err) {
    if (err instanceof OrbitalNotFoundError) return null;
    throw err;
  }
}
