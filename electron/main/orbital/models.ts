/**
 * Orbital Market API response shapes. Narrowed from `src-tauri/src/orbital/api_models.rs`
 * — only fields the renderer actually consumes are carried over so the
 * parsing path stays simple.
 */

export interface OrbitalSearchItem {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  owner?: { name?: string | null } | null;
  // price/discount/rating arrive as strings from some API responses — `search.ts`
  // normalizes them to real numbers, so these are guaranteed numbers downstream.
  price?: number | null;
  discount?: number | null;
  rating?: { average?: number | null; count?: number | null } | null;
  media?: { images?: Array<{ url: string; type?: string }> } | null;
  releaseDate?: string | null;
  lastModified?: string | null;
}

/**
 * Orbital product-detail response (`GET /api/products/product/:slug`).
 *
 * IMPORTANT: this is a DIFFERENT shape from `OrbitalSearchItem` (the search
 * endpoint). The detail endpoint nests differently — `price.value` (cents) not
 * a top-level number, `review.{rating,count}` not `rating.{average,count}`,
 * `media.images` is a bare `string[]` not `{url}[]`, `description` is an
 * object, `category` is singular, `engine.{min,max}` instead of an
 * `engineVersions` array. The previous declaration `extends OrbitalSearchItem`
 * and lied about all of this, which forced `enrich.ts` to cast through
 * `as any` and made the manual-match path in `commands.ts` silently read
 * undefined fields and write nulls. Declared standalone so the field-mapper
 * can be fully typed.
 */
export interface OrbitalProductDetail {
  slug?: string | null;
  title?: string | null;
  description?: {
    long?: string | null;
    short?: string | null;
    technical?: string | null;
  } | null;
  price?: {
    value?: number | null;
    history?: Array<{ date?: string | null; value?: number | null }> | null;
  } | null;
  review?: { rating?: number | null; count?: number | null } | null;
  media?: { images?: string[] | null; thumbnail?: string | null } | null;
  owner?: { name?: string | null } | null;
  category?: string | null;
  engine?: { min?: string | null; max?: string | null } | null;
  releaseDate?: string | null;
}

export interface OrbitalSearchRequest {
  searchText: string;
  limit?: number;
  skip?: number;
  sortField?: 'popularity' | 'release' | 'updated' | 'name' | 'price' | 'rating';
  sortDirection?: 'asc' | 'desc';
}
