import type { Database } from 'better-sqlite3';
import { subtitleStem, videoStem } from '../../scanner/subtitles';

/**
 * Course manifest queries.
 *
 * Learn's whole problem was that a course was a folder name. These read the
 * manifest the scanner writes (`scanner/course-manifest.ts`) so the screen can
 * say 18h 42m, 64 videos, 6 chapters, subtitles present — and resume where you
 * stopped.
 */

export interface CourseFileInput {
  readonly relPath: string;
  readonly absPath: string;
  readonly kind: string;
  readonly chapter: string | null;
  readonly orderIndex: number;
  readonly sizeBytes: number;
  readonly durationSeconds: number | null;
}

/**
 * Replace a course's manifest.
 *
 * Deletes by `asset_id` then re-inserts, which would normally throw playback
 * positions away with the rows they hang off. `course_progress` is therefore
 * carried across by `rel_path`: the path is what identifies a lesson, and a
 * re-scan of an unchanged course must not reset how far you got.
 */
export function replaceCourseManifest(
  db: Database,
  assetId: number,
  files: readonly CourseFileInput[],
): void {
  const carried = db
    .prepare(
      `SELECT f.rel_path AS rel_path, p.position_seconds AS position_seconds,
              p.completed AS completed
         FROM course_files f
         JOIN course_progress p ON p.file_id = f.id
        WHERE f.asset_id = ?`,
    )
    .all(assetId) as { rel_path: string; position_seconds: number; completed: number }[];

  db.prepare('DELETE FROM course_files WHERE asset_id = ?').run(assetId);

  const insert = db.prepare(
    `INSERT INTO course_files
       (asset_id, rel_path, abs_path, kind, chapter, order_index, size_bytes, duration_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of files) {
    insert.run(
      assetId,
      f.relPath,
      f.absPath,
      f.kind,
      f.chapter,
      f.orderIndex,
      f.sizeBytes,
      f.durationSeconds,
    );
  }

  if (carried.length === 0) return;
  const restore = db.prepare(
    `INSERT OR REPLACE INTO course_progress (file_id, position_seconds, completed)
     SELECT id, ?, ? FROM course_files WHERE asset_id = ? AND rel_path = ?`,
  );
  for (const row of carried) {
    restore.run(row.position_seconds, row.completed, assetId, row.rel_path);
  }
}

/** Durations already on record for a course, so a re-scan can skip re-reading. */
export function knownDurations(
  db: Database,
  assetId: number,
): Map<string, { size: number; duration: number | null }> {
  const rows = db
    .prepare('SELECT rel_path, size_bytes, duration_seconds FROM course_files WHERE asset_id = ?')
    .all(assetId) as { rel_path: string; size_bytes: number; duration_seconds: number | null }[];
  return new Map(
    rows.map((r) => [r.rel_path, { size: r.size_bytes, duration: r.duration_seconds }]),
  );
}

export interface CourseSummary {
  readonly id: number;
  readonly name: string;
  /** Recovered human title; null when the folder name already reads well. */
  readonly display_title: string | null;
  readonly file_path: string | null;
  readonly tutorial_source: string | null;
  readonly thumbnail_path: string | null;
  readonly video_count: number;
  readonly chapter_count: number;
  readonly subtitle_count: number;
  /** Sealed archives. Non-zero with no videos means "extract this first". */
  readonly archive_count: number;
  /** Seconds across videos whose duration could be read; null when none could. */
  readonly duration_seconds: number | null;
  readonly size_bytes: number;
  /** 0–100, by videos completed. Null when the course has no videos. */
  readonly percent_complete: number | null;
  readonly has_manifest: number;
}

const SUMMARY_SQL = `
  SELECT
    a.id, a.name, a.display_title, a.file_path, a.tutorial_source, a.thumbnail_path,
    COALESCE(m.video_count, 0)    AS video_count,
    COALESCE(m.chapter_count, 0)  AS chapter_count,
    COALESCE(m.subtitle_count, 0) AS subtitle_count,
    COALESCE(m.archive_count, 0)  AS archive_count,
    m.duration_seconds            AS duration_seconds,
    COALESCE(m.size_bytes, 0)     AS size_bytes,
    CASE WHEN COALESCE(m.video_count, 0) = 0 THEN NULL
         ELSE CAST(COALESCE(p.done, 0) AS REAL) * 100.0 / m.video_count END AS percent_complete,
    CASE WHEN m.video_count IS NULL THEN 0 ELSE 1 END AS has_manifest
  FROM assets a
  LEFT JOIN (
    SELECT asset_id,
           SUM(kind = 'video')                                   AS video_count,
           SUM(kind = 'subtitle')                                AS subtitle_count,
           SUM(kind = 'archive')                                 AS archive_count,
           COUNT(DISTINCT CASE WHEN chapter IS NOT NULL THEN chapter END) AS chapter_count,
           SUM(CASE WHEN kind = 'video' THEN duration_seconds END)        AS duration_seconds,
           SUM(size_bytes)                                       AS size_bytes
      FROM course_files GROUP BY asset_id
  ) m ON m.asset_id = a.id
  LEFT JOIN (
    SELECT f.asset_id, COUNT(*) AS done
      FROM course_files f
      JOIN course_progress cp ON cp.file_id = f.id
     WHERE f.kind = 'video' AND cp.completed = 1
     GROUP BY f.asset_id
  ) p ON p.asset_id = a.id
  WHERE a.content_format IS NOT NULL AND a.missing_since IS NULL`;

export function listCourses(db: Database): CourseSummary[] {
  return db.prepare(`${SUMMARY_SQL} ORDER BY a.name COLLATE NOCASE`).all() as CourseSummary[];
}

export function getCourse(db: Database, assetId: number): CourseSummary | null {
  return (db.prepare(`${SUMMARY_SQL} AND a.id = ?`).get(assetId) as CourseSummary) ?? null;
}

export interface CourseFileRow {
  readonly id: number;
  readonly rel_path: string;
  readonly abs_path: string;
  readonly kind: string;
  readonly chapter: string | null;
  readonly order_index: number;
  readonly duration_seconds: number | null;
  readonly position_seconds: number | null;
  readonly completed: number;
  /** 1 when a subtitle file sits beside this video with the same stem. */
  readonly has_subtitle: number;
}

export function listCourseFiles(db: Database, assetId: number): CourseFileRow[] {
  const rows = db
    .prepare(
      `SELECT f.id, f.rel_path, f.abs_path, f.kind, f.chapter, f.order_index,
              f.duration_seconds,
              p.position_seconds,
              COALESCE(p.completed, 0) AS completed
         FROM course_files f
         LEFT JOIN course_progress p ON p.file_id = f.id
        WHERE f.asset_id = ?`,
    )
    .all(assetId) as Omit<CourseFileRow, 'has_subtitle'>[];

  // "Does this lesson have subtitles?" is a stem match — `03 - Foo.mp4` pairs
  // with `03 - Foo.srt`. Expressing that in SQL means slicing extensions with
  // substr/length arithmetic, which is unreadable and easy to get subtly
  // wrong; a Set here is one line and obviously correct.
  //
  // This used to strip one extension from BOTH sides, which silently failed on
  // the `03 - Foo.mp4.srt` convention — `foo.mp4` never equals `foo`. That is
  // the shape `scripts/asr/backfill.py` writes, so every Whisper-generated
  // sidecar reported "no subtitles". Both sides now go through the shared
  // helpers so the flag and the served track can never disagree.
  const subtitleStems = new Set(
    rows.filter((r) => r.kind === 'subtitle').map((r) => subtitleStem(r.rel_path)),
  );

  // Ordering happens here, not in SQL. `COLLATE NOCASE` is lexical, so a
  // course with more than nine chapters listed "1 -", "10 -", "11 -", "2 -" —
  // the same trap the filename ordering already avoids. SQLite has no numeric
  // collation, and localeCompare with numeric:true does exactly this.
  const byNumber = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  return rows
    .map((r) => ({
      ...r,
      has_subtitle: r.kind === 'video' && subtitleStems.has(videoStem(r.rel_path)) ? 1 : 0,
    }))
    .sort((a, b) => {
      // Root-level files first, then chapters in the author's numbering.
      if ((a.chapter === null) !== (b.chapter === null)) return a.chapter === null ? -1 : 1;
      const ch = byNumber(a.chapter ?? '', b.chapter ?? '');
      if (ch !== 0) return ch;
      if (a.order_index !== b.order_index) return a.order_index - b.order_index;
      return byNumber(a.rel_path, b.rel_path);
    });
}

/** `X.en.srt`, `X.en_US.vtt` — the tag Whisper's translation pass writes. */
const ENGLISH_TAG = /\.en([-_][A-Za-z]{2,4})?\.(srt|vtt)$/i;

/**
 * Absolute path of the subtitle sidecar belonging to one video, or null.
 *
 * Same stem match `listCourseFiles` uses for its `has_subtitle` flag, but
 * resolved to a path so the file can actually be served to a `<track>`. Scoped
 * to the video's own course: two courses can both contain `01 - Intro.mp4`, and
 * a global stem match would hand back the wrong lesson's captions.
 */
export function subtitlePathForVideo(db: Database, videoFileId: number): string | null {
  const video = db
    .prepare("SELECT asset_id, rel_path FROM course_files WHERE id = ? AND kind = 'video'")
    .get(videoFileId) as { asset_id: number; rel_path: string } | undefined;
  if (!video) return null;

  const wanted = videoStem(video.rel_path);
  const subs = db
    .prepare("SELECT rel_path, abs_path FROM course_files WHERE asset_id = ? AND kind = 'subtitle'")
    .all(video.asset_id) as { rel_path: string; abs_path: string }[];

  const matches = subs.filter((s) => subtitleStem(s.rel_path) === wanted);
  // A foreign-language lesson can carry both its native `X.srt` and the Whisper
  // `X.en.srt` translation. Prefer English explicitly — picking the first match
  // would hand back whichever row the DB happened to return.
  return (
    matches.find((s) => ENGLISH_TAG.test(s.rel_path))?.abs_path ?? matches[0]?.abs_path ?? null
  );
}

export function setProgress(
  db: Database,
  fileId: number,
  positionSeconds: number,
  completed: boolean,
): void {
  db.prepare(
    `INSERT INTO course_progress (file_id, position_seconds, completed, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(file_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       completed = excluded.completed,
       updated_at = excluded.updated_at`,
  ).run(fileId, positionSeconds, completed ? 1 : 0);
}

/** The most recently touched, still-unfinished lesson. Drives "Resume". */
export function lastPlayed(
  db: Database,
): { asset_id: number; file_id: number; rel_path: string; position_seconds: number } | null {
  return (
    (db
      .prepare(
        `SELECT f.asset_id, f.id AS file_id, f.rel_path, p.position_seconds
           FROM course_progress p
           JOIN course_files f ON f.id = p.file_id
          WHERE p.completed = 0 AND p.position_seconds > 0
          ORDER BY p.updated_at DESC LIMIT 1`,
      )
      .get() as {
      asset_id: number;
      file_id: number;
      rel_path: string;
      position_seconds: number;
    }) ?? null
  );
}

export function replaceTranscript(
  db: Database,
  fileId: number,
  cues: readonly { startMs: number; text: string }[],
): void {
  // transcript_fts is an external-content index over this table and is kept in
  // sync by triggers, so both statements below are ordinary indexed writes. The
  // delete used to scan the entire corpus once per lesson.
  db.prepare('DELETE FROM transcript_cues WHERE file_id = ?').run(fileId);
  const insert = db.prepare(
    'INSERT INTO transcript_cues (file_id, start_ms, text) VALUES (?, ?, ?)',
  );
  for (const cue of cues) insert.run(fileId, cue.startMs, cue.text);
}

export interface TranscriptHit {
  readonly file_id: number;
  readonly start_ms: number;
  readonly text: string;
  readonly asset_id: number;
  readonly course_name: string;
  readonly rel_path: string;
  readonly chapter: string | null;
}

/**
 * Full-text search across subtitle cues.
 *
 * Same FTS5 sanitising as `searchAssets`: user text is quoted per token with a
 * trailing `*`, so stray quotes and colons are terms rather than operators.
 */
export function searchTranscripts(db: Database, query: string, limit = 50): TranscriptHit[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  if (tokens.length === 0) return [];

  return db
    .prepare(
      `SELECT c.file_id, c.start_ms, c.text,
              f.asset_id, f.rel_path, f.chapter, a.name AS course_name
         FROM transcript_fts t
         JOIN transcript_cues c ON c.id = t.rowid
         JOIN course_files f ON f.id = c.file_id
         JOIN assets a ON a.id = f.asset_id
        WHERE transcript_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(tokens.join(' '), limit) as TranscriptHit[];
}

/**
 * Fill in `tutorial_source` for courses that already have a manifest.
 *
 * Runs off stored data — the course name plus the `rel_path`s under it — so it
 * needs no filesystem walk and no re-scan. That matters because the manifest
 * pass is the expensive part (a file handle per video), and attribution is
 * pure string work over rows we already have.
 *
 * `detect` is injected rather than imported so this repo stays free of scanner
 * imports and the caller owns the vendor list.
 */
export function backfillTutorialSources(
  db: Database,
  detect: (courseName: string, innerPaths: readonly string[]) => string | null,
  deriveTitle?: (courseName: string, innerPaths: readonly string[]) => string | null,
): { readonly examined: number; readonly updated: number; readonly titled: number } {
  const courses = db
    .prepare(
      `SELECT DISTINCT a.id, a.name
         FROM assets a JOIN course_files f ON f.asset_id = a.id
        WHERE a.content_format IS NOT NULL`,
    )
    .all() as { id: number; name: string }[];

  const pathsOf = db.prepare('SELECT rel_path FROM course_files WHERE asset_id = ? LIMIT 400');
  const update = db.prepare('UPDATE assets SET tutorial_source = ? WHERE id = ?');

  const setTitle = db.prepare('UPDATE assets SET display_title = ? WHERE id = ?');
  let updated = 0;
  let titled = 0;
  for (const course of courses) {
    const paths = (pathsOf.all(course.id) as { rel_path: string }[]).map((r) => r.rel_path);
    const source = detect(course.name, paths);
    if (source) updated += update.run(source, course.id).changes;
    const title = deriveTitle?.(course.name, paths);
    if (title) titled += setTitle.run(title, course.id).changes;
  }
  return { examined: courses.length, updated, titled };
}
