import { z } from 'zod';

// Matches the legacy Rust SortOption enum (serde rename_all = "snake_case").
export const sortOptionSchema = z.enum([
  'name_asc',
  'name_desc',
  'date_asc',
  'date_desc',
  'date_added_asc',
  'date_added_desc',
  'rating_desc',
  'rating_asc',
  'reviews_desc',
  'price_desc',
  'price_asc',
  'size_desc',
  'size_asc',
  'favorites_first',
]);

export const dateRangeSchema = z.object({
  start: z.string(),
  end: z.string(),
});

// Matches `AssetFilter`. Every field required with `| null` — missing fields
// become undefined through the IPC boundary and that mismatches Rust/SQLite
// semantics. Use `null` for "no filter", not omission.
export const assetFilterSchema = z
  .object({
    asset_type: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    name_search: z.string().nullable(),
    is_favorite: z.boolean().nullable(),
    scan_location_id: z.number().nullable(),
    date_range: dateRangeSchema.nullable(),
    // Below are post-Tauri additions to support the React sidebar's filter
    // composition. `category` searches the `orbital_categories` JSON array.
    // `ecosystem` matches the `asset_ecosystem`/`ecosystem` column.
    category: z.string().nullable().optional(),
    ecosystem: z.string().nullable().optional(),
    // `match_status` filters by orbital-match presence for the Marketplace facets.
    // 'needs_review' is 'unmatched' minus what the user dismissed in the
    // Match queue. Kept separate so the Library sidebar's Unmatched facet,
    // which maps to 'unmatched', keeps reporting the data honestly.
    match_status: z.enum(['orbital', 'unmatched', 'needs_review']).nullable().optional(),
  })
  .nullable();

export const listAssetsInputSchema = z.object({
  filter: assetFilterSchema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  sort: sortOptionSchema.optional(),
});

export const searchAssetsInputSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  // Sidebar facets intersect with the query rather than being replaced by it.
  filter: assetFilterSchema.optional(),
});

export const idSchema = z.number().int().positive();
export const idsSchema = z.array(idSchema);

// What kind of content a location holds. Mirrors `assets.content_format`
// (migration 20260409000000); null means regular assets.
export const contentFormatSchema = z.enum(['course', 'workshop', 'ebook', 'reference', 'bookmark']);

export const scanLocationInputSchema = z.object({
  name: z.string(),
  path: z.string(),
  is_active: z.boolean(),
  last_scan: z.string().nullable(),
  scan_recursive: z.boolean(),
  file_extensions: z.string().nullable(),
  description: z.string().nullable(),
  // `.default(null)` rather than `.optional()`: callers that predate the column
  // may omit it, but the parsed value is always present, so the repo's
  // `ContentFormat | null` stays non-optional. Omitted means regular assets.
  content_format: contentFormatSchema.nullable().default(null),
});

// Partial edit of an existing scan location — every field except `id` is
// optional so the renderer can PATCH only what changed. Maps to the repo's
// `ScanLocationUpdate`.
export const scanLocationUpdateSchema = z.object({
  id: idSchema,
  name: z.string().optional(),
  path: z.string().optional(),
  is_active: z.boolean().optional(),
  scan_recursive: z.boolean().optional(),
  file_extensions: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  content_format: contentFormatSchema.nullable().optional(),
});

// Replaces the full user-tag set for one asset (canonical `asset_tags` store +
// the re-serialized `assets.tags` JSON).
export const setTagsSchema = z.object({
  assetId: idSchema,
  tags: z.array(z.string()),
});

// Bulk tagging is ADD-only, never replace — see addAssetTags for why. A plural
// form of setTags would make destroying a whole selection's curation one click
// away from the benign case.
export const addTagsSchema = z.object({
  ids: idsSchema,
  tags: z.array(z.string()).min(1),
});

// Matches `CreateCollectionRequest` exactly.
export const createCollectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  is_smart: z.boolean().nullable(),
  smart_filter: z.string().nullable(),
});

// Matches `NoteRequest` exactly.
export const noteRequestSchema = z.object({
  asset_id: idSchema,
  note_text: z.string().nullable(),
  rating: z.number().min(0).max(5).nullable(),
  tested_ue_versions: z.array(z.string()).nullable(),
  reminders: z.array(z.string()).nullable(),
});

export const learnFilterSchema = z
  .object({
    format: z.string().nullable(),
    source: z.string().nullable(),
    software: z.string().nullable(),
    limit: z.number().int().positive().nullable(),
    offset: z.number().int().nonnegative().nullable(),
  })
  .partial();

// Library Health drill-down. `kind` must stay in lockstep with
// `ScanDiagnosticKind` in `shared/types/db/scan-diagnostic.ts`.
export const scanDiagnosticKindSchema = z.enum([
  'archive-only',
  'depth-limit-abandoned',
  'thumbnail-failed',
  'path-near-max-length',
]);

export const diagnosticListSchema = z.object({
  kind: scanDiagnosticKindSchema,
  limit: z.number().int().positive().max(5000).optional(),
});
