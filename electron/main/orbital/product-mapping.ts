import type { OrbitalProductDetail } from './models';

/**
 * Shared Orbital field-mapping helper.
 *
 * ONE place that maps a raw Orbital product-detail response onto the asset
 * columns. Used by the bulk enrich path (`enrich.ts`). Before this existed the
 * manual and bulk paths read DIFFERENT (and the manual path WRONG) field
 * shapes:
 *
 *   - manual path read `media.images[0].url`  → images are bare URL strings,
 *     so `.url` was always `undefined` and the thumbnail wrote `null`.
 *   - manual path read `rating.{average,count}` → real shape is
 *     `review.{rating,count}`, so rating wrote `null`.
 *   - manual path read top-level `price` (number) → real shape is
 *     `price.value` (cents), so price wrote `null`.
 *
 * The real Orbital product-detail shape (now reflected in
 * `OrbitalProductDetail`):
 *   description: { long: HTML, short?, technical? }
 *   price: { value: cents, history: [{date, value}] }
 *   review: { rating, count }
 *   media.images: string[] of URLs
 *   media.thumbnail: string URL
 *   category: string (singular)
 *   engine: { min, max }
 *   No top-level lastModified — derive from latest price-history date.
 *
 * No algorithm change, no change to WHICH data is fetched — this only
 * normalizes the read shape so both write paths agree.
 */

/** Strongly-typed projection of an Orbital detail onto asset columns. */
export interface MappedOrbitalFields {
  slug: string | null;
  title: string | null;
  /** Plain-text long description (HTML stripped). */
  description: string | null;
  /** Plain-text technical details (HTML stripped). */
  technical: string | null;
  /** First gallery thumbnail URL, or null. */
  heroUrl: string | null;
  /** Gallery image URLs as `{ url }[]`, JSON-stringified for storage, or null. */
  gallery: string | null;
  seller: string | null;
  /** Price in cents. */
  priceCents: number | null;
  releaseDate: string | null;
  /** Latest price-history date, used as a last-modified proxy. */
  lastModified: string | null;
  ratingAvg: number | null;
  ratingCount: number | null;
  /** Category list, JSON-stringified, or null. */
  categories: string | null;
  /** Supported engine versions (e.g. `["UE 5.1–5.4"]`), JSON-stringified, or null. */
  supportedVersions: string | null;
  /** Canonical orbital-market.com product URL, or null when slug is missing. */
  sourceUrl: string | null;
}

/**
 * Strip HTML tags from Orbital descriptions (which arrive as small HTML
 * fragments). Keeps paragraph breaks, decodes the handful of named entities
 * the API emits, collapses excess whitespace.
 */
export function stripHtml(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  let text = input;
  // Block-level tags become double newlines (paragraph), <br> becomes single.
  text = text.replace(/<\s*(p|div|h[1-6]|li|blockquote|pre)\b[^>]*>/gi, '\n');
  text = text.replace(/<\s*\/(p|div|h[1-6]|li|blockquote|pre)\s*>/gi, '\n');
  text = text.replace(/<\s*br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Map a raw Orbital product detail onto the normalized asset-column fields.
 * Every field is narrowed defensively so a future API drift degrades to
 * `null` rather than crashing or writing garbage.
 */
export function mapOrbitalDetailToAssetFields(
  detail: OrbitalProductDetail,
): MappedOrbitalFields {
  const slug = typeof detail.slug === 'string' ? detail.slug : null;

  const galleryStrings: string[] = Array.isArray(detail.media?.images)
    ? detail.media.images.filter((x): x is string => typeof x === 'string')
    : [];
  const heroUrl: string | null =
    typeof detail.media?.thumbnail === 'string' ? detail.media.thumbnail : null;

  const priceCents = typeof detail.price?.value === 'number' ? detail.price.value : null;
  const priceHistory = Array.isArray(detail.price?.history) ? detail.price.history : [];
  const lastModified: string | null =
    priceHistory.length > 0 && typeof priceHistory[priceHistory.length - 1]?.date === 'string'
      ? (priceHistory[priceHistory.length - 1]?.date ?? null)
      : null;

  const categories: string[] = typeof detail.category === 'string' ? [detail.category] : [];

  const engineMin: string | null = typeof detail.engine?.min === 'string' ? detail.engine.min : null;
  const engineMax: string | null = typeof detail.engine?.max === 'string' ? detail.engine.max : null;
  const engineVersions: string[] =
    engineMin && engineMax && engineMin !== engineMax
      ? [`UE ${engineMin}–${engineMax}`]
      : engineMin
        ? [`UE ${engineMin}+`]
        : [];

  return {
    slug,
    title: typeof detail.title === 'string' ? detail.title : null,
    description: stripHtml(detail.description?.long),
    technical: stripHtml(detail.description?.technical),
    heroUrl,
    gallery:
      galleryStrings.length > 0
        ? JSON.stringify(galleryStrings.map((url) => ({ url })))
        : null,
    seller: typeof detail.owner?.name === 'string' ? detail.owner.name : null,
    priceCents,
    releaseDate: typeof detail.releaseDate === 'string' ? detail.releaseDate : null,
    lastModified,
    ratingAvg: typeof detail.review?.rating === 'number' ? detail.review.rating : null,
    ratingCount: typeof detail.review?.count === 'number' ? detail.review.count : null,
    categories: categories.length > 0 ? JSON.stringify(categories) : null,
    supportedVersions: engineVersions.length > 0 ? JSON.stringify(engineVersions) : null,
    sourceUrl: slug ? `https://orbital-market.com/product/${slug}` : null,
  };
}
