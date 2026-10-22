# Database schema

Source of truth: `electron/main/db/migrations/*.up.sql`, applied in filename order. This page describes the live tables; it does not restate every column.

To read the current schema directly:

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.APPDATA+'/omnidex/omnidex.db',{readOnly:true});
for(const r of db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").all()) console.log(r.sql,'\n');
"
```

## Core

### `assets`

One row per pack or course, unique on `file_path`.

| Column group | Columns |
|---|---|
| Identity | `id`, `name`, `file_path`, `asset_type`, `file_size`, `file_size_is_partial`, `file_hash` |
| Classification | `content_format`, `ecosystem`, `asset_ecosystem`, `scan_location_id` |
| Curation | `is_favorite`, `display_title`, `description`, `tags`, `metadata` |
| Thumbnail | `thumbnail_path`, `has_local_thumbnail` |
| Marketplace | `orbital_title`, `orbital_description`, `orbital_seller_name`, `orbital_price`, `orbital_rating_average`, `orbital_rating_count`, `orbital_categories`, `orbital_supported_versions`, `orbital_release_date`, `orbital_gallery_images`, `orbital_fab_id` |
| Lifecycle | `created_date`, `modified_date`, `first_indexed_timestamp`, `last_accessed`, `missing_since` |

`content_format` is the routing column: `NULL` is a pack, `'course'` is a course.

### `scan_locations`

| Column | Meaning |
|---|---|
| `path` | Root folder |
| `name` | Display name |
| `is_active` | Included in `refreshAll` |
| `content_format` | `NULL` for packs, `'course'` for courses. Selects flat-mode walking. |
| `scan_recursive` | Descend into subfolders |
| `file_extensions` | Optional extension filter |
| `last_scan` | Timestamp of the last completed scan |

## Courses

### `course_files`

One row per file inside a course. `UNIQUE (asset_id, rel_path)`.

| Column | Meaning |
|---|---|
| `asset_id` | Owning course. `ON DELETE CASCADE`. |
| `rel_path`, `abs_path` | Path within the course, and absolute |
| `kind` | `video`, `subtitle`, or `doc` |
| `chapter`, `order_index` | Derived from folder layout and author numbering |
| `size_bytes`, `duration_seconds` | Read during manifest building |

```admonish danger title="Ids are reassigned on every scan"
Re-scanning deletes and reinserts these rows, so `course_files.id` is not stable across scans. Anything referencing it must cascade or be re-derived.
```

### `course_progress`

`file_id` primary key, cascading from `course_files`. Holds `position_seconds`, `completed`, `updated_at`.

Carried across a re-scan by `rel_path`, since ids change.

### `transcript_cues`

| Column | Meaning |
|---|---|
| `id` | Rowid; also `transcript_fts`'s `content_rowid` |
| `file_id` | The **subtitle** `course_files` row, not the video. `ON DELETE CASCADE`. |
| `start_ms` | Cue start |
| `text` | Cue text |

Indexed on `(file_id, start_ms)`.

### `transcript_fts`

FTS5 external-content index over `transcript_cues`:

```sql
CREATE VIRTUAL TABLE transcript_fts USING fts5 (
  text, content = 'transcript_cues', content_rowid = 'id',
  tokenize = 'porter unicode61'
);
```

Kept in sync by `AFTER INSERT`, `AFTER DELETE`, and `AFTER UPDATE` triggers on `transcript_cues`. Query it by joining back:

```sql
SELECT c.text, c.file_id, c.start_ms
FROM transcript_fts t
JOIN transcript_cues c ON c.id = t.rowid
WHERE transcript_fts MATCH ?
ORDER BY rank
```

## Curation

| Table | Holds |
|---|---|
| `asset_tags` | `asset_id`, `tag`, `tag_type`, `confidence`, `source` |
| `asset_notes` | Free-text note per asset |
| `collections` | `name`, `description`, `color`, `icon`, `is_smart`, `smart_filter` |
| `collection_items` | Membership |

## Operational

| Table | Holds |
|---|---|
| `scan_diagnostics` | Why a folder was skipped. Drives the Library Health view. |
| `orbital_match_rejections` | Persistent rejections. Unique on `(asset_id, COALESCE(product_slug, ''))`. |
| `orbital_product_cache`, `orbital_catalog_index`, `orbital_catalog_sync` | Marketplace cache, 24-hour TTL |
| `fab_library_items`, `fab_assets`, `fab_metadata` | Epic FAB import |
| `app_settings`, `settings` | Persisted settings |
| `assets_fts` | FTS5 over pack names and marketplace titles, BM25-weighted to favour the name |
| `_omnidex_migrations` | Applied migrations |

## Legacy

Present but not written by current code: `_sqlx_migrations` (from the pre-Electron Tauri build), `assets_v2`, `batch_state`, `marketplace_assets`, `marketplace_cache`, `marketplace_metadata`, `marketplace_scores`, `asset_marketplace_matches`, `scraper_metrics`, `orbital_metadata`.

Migration `20260614000000_drop_dead_tables` removed one batch; the rest are inert.

```admonish warning title="Check the repo layer before building on a table"
The presence of a table proves nothing about whether anything maintains it. `electron/main/db/repos/` is the list of what is actually read and written.
```

## Next steps

- [The data model](../orientation/data-model.md) — what the relationships mean
- [Write a migration](../guides/write-a-migration.md) — changing any of this
