/**
 * The statement the scan's background thumbnail job writes with, on its own so
 * tests can bind to it without loading the napi addon `pipeline.ts` imports
 * (same reason as `asset-upsert.ts`).
 *
 * Fills an empty thumbnail only — null or `''`, the same test the scan uses
 * (`!row?.thumbnail_path`) when it queues a row, so a queued row can be written. The job's targets are chosen during the upsert
 * pass, when the row had no thumbnail, but it runs after `indexCourseManifests`
 * — which may have set a course cover by then — and alongside anything else
 * that sets one while it works. Without the guard it replaced the course's
 * cover art with whatever stray image or `.uasset` it found in the folder.
 *
 * Nothing relies on this job to overwrite: it only ever queues rows whose
 * `thumbnail_path` was null, and "Purge thumbnails" in Settings refreshes by
 * nulling the column first.
 */
export const BACKGROUND_THUMBNAIL_SQL =
  "UPDATE assets SET thumbnail_path = ?, has_local_thumbnail = 1 WHERE file_path = ? AND (thumbnail_path IS NULL OR thumbnail_path = '')";
