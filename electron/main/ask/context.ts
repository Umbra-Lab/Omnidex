import type { Database } from 'better-sqlite3';
import { subtitleStem } from '../scanner/subtitles';

/**
 * Assemble one course's transcript into an LLM context under a token budget.
 *
 * Two measured realities shape this (2026-08-05, live library):
 *
 * - Multi-language rips duplicate subtitles up to 11x under `_/` translation
 *   folders. One subtitle file is chosen per lesson — English-tagged first,
 *   then anything outside a `_/` folder — or the biggest course balloons from
 *   ~408k to ~4.4M estimated tokens.
 * - Even deduplicated, 7 of 27 transcribed courses exceed 400k tokens, so
 *   "whole course" cannot be unconditional. Over budget, lessons that match
 *   the question (FTS) are included whole first, then course order fills the
 *   remainder ('scoped' mode); the renderer surfaces which subset was used.
 *
 * Token estimate is chars/4 — coarse, but budgets here are soft limits chosen
 * per provider, not hard context walls.
 */

export interface LessonRef {
  /** The subtitle file's course_files id — the id the model cites. */
  lessonId: number;
  /** The paired video's course_files id, or null when no video matched. */
  videoFileId: number | null;
  title: string;
  chapter: string | null;
}

export interface CourseContext {
  text: string;
  mode: 'full' | 'scoped';
  lessonCount: number;
  includedCount: number;
  tokenEstimate: number;
  lessons: LessonRef[];
}

interface FileRow {
  id: number;
  rel_path: string;
  kind: string;
  chapter: string | null;
  order_index: number;
}

interface Cue {
  start_ms: number;
  text: string;
}

/** Same numeric-aware ordering `listCourseFiles` uses — "2 -" before "10 -". */
const byNumber = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** English-tagged subtitle names win; `_/` translation folders lose. */
function languageScore(relPath: string): number {
  const low = relPath.toLowerCase();
  let score = 0;
  if (/english/.test(low) || /\.en([-_][a-z]{2,4})?\.(srt|vtt)$/.test(low)) score += 2;
  if (!/(^|\/)_\//.test(low)) score += 1;
  return score;
}

/** A trailing spelled-out language: `lesson.English.srt`, `lesson.Vietnamese.srt`. */
const LANG_WORD = /\.[a-z]{3,12}$/i;

/**
 * Trailing language names, dot- OR space-separated. The space form is what the
 * live library actually uses — `2 Welcome to the Course Simplified Chinese.srt`
 * beside `2 Welcome to the Course.mp4` — measured on the 11-language course
 * whose 2,448 subtitle files must collapse to its 204 lessons.
 */
const LANG_NAMES =
  /(?:[ ._-](?:english|spanish|french|german|italian|dutch|polish|portuguese|romanian|turkish|thai|vietnamese|indonesian|arabic|japanese|korean|russian|ukrainian|hindi|(?:simplified[ ._-]|traditional[ ._-])?chinese))+$/i;

/**
 * The key that makes a video and every language variant of its subtitles one
 * lesson. Stricter stems are not enough here: translations sit under `_/`
 * subfolders and carry language suffixes in several spellings, so their paths
 * never equal the video's stem. Dropping `_` path segments, one trailing
 * dot-word, and trailing language names collapses them. A lesson legitimately
 * named after a language collides under this key — acceptable for context
 * grouping, where the cost is choosing one subtitle among two lessons, not
 * losing data.
 */
function lessonKey(relPath: string): string {
  const segments = relPath.split('/').filter((s) => s !== '_');
  const base = segments.pop() ?? relPath;
  const dir = segments.join('/').toLowerCase();
  return `${dir}/${subtitleStem(base).replace(LANG_WORD, '').replace(LANG_NAMES, '')}`;
}

/**
 * chars/4 is badly wrong for CJK (closer to one token per character), and the
 * scoped packer must not over-pack when Asian-language text slips through.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[　-鿿가-힯฀-๿]/g)?.length ?? 0;
  return Math.round((text.length - cjk) / 4 + cjk);
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  // Hour-long lessons must not render `75:03` — a model told to convert
  // "[m:ss]" to seconds reads that as h:mm and cites the wrong minute.
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** New timestamp marker roughly once a minute of speech. */
const MARKER_EVERY_MS = 60_000;

interface LessonBlock extends LessonRef {
  sortChapter: string;
  sortOrder: number;
  sortPath: string;
  text: string;
}

export function assembleCourseContext(
  db: Database,
  assetId: number,
  tokenBudget: number,
  question: string,
): CourseContext | null {
  const rows = db
    .prepare(
      `SELECT id, rel_path, kind, chapter, order_index FROM course_files
        WHERE asset_id = ? AND kind IN ('video', 'subtitle')`,
    )
    .all(assetId) as FileRow[];

  const videosByKey = new Map<string, FileRow>();
  for (const r of rows) if (r.kind === 'video') videosByKey.set(lessonKey(r.rel_path), r);

  // One subtitle per lesson.
  const chosen = new Map<string, FileRow>();
  for (const r of rows) {
    if (r.kind !== 'subtitle') continue;
    const stem = lessonKey(r.rel_path);
    const prev = chosen.get(stem);
    if (
      !prev ||
      languageScore(r.rel_path) > languageScore(prev.rel_path) ||
      (languageScore(r.rel_path) === languageScore(prev.rel_path) &&
        r.rel_path.length < prev.rel_path.length)
    ) {
      chosen.set(stem, r);
    }
  }
  if (chosen.size === 0) return null;

  // All cues for the chosen files in one pass. transcript_cues is indexed on
  // (file_id, start_ms), so this is a handful of B-tree seeks rather than the
  // full-corpus scan the same shape cost against the FTS table.
  const subs = [...chosen.values()];
  const placeholders = subs.map(() => '?').join(', ');
  const cueRows = db
    .prepare(
      `SELECT file_id, start_ms, text FROM transcript_cues WHERE file_id IN (${placeholders})`,
    )
    .all(...subs.map((s) => s.id)) as (Cue & { file_id: number })[];
  const cuesByFile = new Map<number, Cue[]>();
  for (const c of cueRows) {
    const list = cuesByFile.get(c.file_id) ?? [];
    list.push({ start_ms: c.start_ms, text: c.text });
    cuesByFile.set(c.file_id, list);
  }

  const blocks: LessonBlock[] = [];
  for (const [stem, sub] of chosen) {
    const cues = cuesByFile.get(sub.id);
    if (!cues || cues.length === 0) continue;
    cues.sort((a, b) => a.start_ms - b.start_ms);

    const video = videosByKey.get(stem) ?? null;
    const anchor = video ?? sub;
    const title = sub.rel_path.split('/').pop() ?? sub.rel_path;

    let text = `\n\n## ${anchor.chapter ? `${anchor.chapter} / ` : ''}${title} (lesson_id=${sub.id})\n`;
    let lastMarker = Number.NEGATIVE_INFINITY;
    const parts: string[] = [];
    for (const cue of cues) {
      if (cue.start_ms - lastMarker >= MARKER_EVERY_MS) {
        parts.push(`\n[${clock(cue.start_ms)}] `);
        lastMarker = cue.start_ms;
      } else {
        parts.push(' ');
      }
      parts.push(cue.text.trim());
    }
    text += parts.join('');

    blocks.push({
      lessonId: sub.id,
      videoFileId: video?.id ?? null,
      title,
      chapter: anchor.chapter,
      sortChapter: anchor.chapter ?? '',
      sortOrder: anchor.order_index,
      sortPath: anchor.rel_path,
      text,
    });
  }
  if (blocks.length === 0) return null;

  blocks.sort((a, b) => {
    if ((a.sortChapter === '') !== (b.sortChapter === '')) return a.sortChapter === '' ? -1 : 1;
    const ch = byNumber(a.sortChapter, b.sortChapter);
    if (ch !== 0) return ch;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return byNumber(a.sortPath, b.sortPath);
  });

  const charBudget = tokenBudget * 4;
  const blockChars = (b: LessonBlock) => estimateTokens(b.text) * 4;
  const totalChars = blocks.reduce((n, b) => n + blockChars(b), 0);

  let included: LessonBlock[];
  let mode: 'full' | 'scoped';
  if (totalChars <= charBudget) {
    included = blocks;
    mode = 'full';
  } else {
    mode = 'scoped';
    const hitCounts = countQuestionHits(db, assetId, question);
    const byHits = [...blocks]
      .filter((b) => (hitCounts.get(b.lessonId) ?? 0) > 0)
      .sort((a, b) => (hitCounts.get(b.lessonId) ?? 0) - (hitCounts.get(a.lessonId) ?? 0));

    const picked = new Set<number>();
    let used = 0;
    for (const b of byHits) {
      if (used + blockChars(b) > charBudget) continue;
      picked.add(b.lessonId);
      used += blockChars(b);
    }
    for (const b of blocks) {
      if (picked.has(b.lessonId)) continue;
      if (used + blockChars(b) > charBudget) continue;
      picked.add(b.lessonId);
      used += blockChars(b);
    }
    included = blocks.filter((b) => picked.has(b.lessonId));
    // A question matching nothing and a first lesson bigger than the whole
    // budget both leave nothing picked; include the best-fitting lesson rather
    // than sending an empty transcript.
    if (included.length === 0) {
      const smallest = [...blocks].sort((a, b) => blockChars(a) - blockChars(b))[0];
      if (smallest) included = [smallest];
    }
  }

  const text = included.map((b) => b.text).join('');
  return {
    text,
    mode,
    lessonCount: blocks.length,
    includedCount: included.length,
    tokenEstimate: estimateTokens(text),
    lessons: included.map(({ lessonId, videoFileId, title, chapter }) => ({
      lessonId,
      videoFileId,
      title,
      chapter,
    })),
  };
}

/**
 * Words that make an OR'd prefix query useless: measured on the live library,
 * `"how"* OR "do"* OR "i"*` ranks chatty lessons (and Dutch translations —
 * ik/in/is) above the lesson that actually answers the question.
 */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'you',
  'your',
  'this',
  'that',
  'with',
  'what',
  'when',
  'where',
  'why',
  'how',
  'can',
  'does',
  'use',
  'are',
  'was',
  'not',
  'but',
  'get',
  'set',
  'make',
  'from',
  'into',
  'about',
  'course',
  'lesson',
  'video',
  'instructor',
]);

/** Per-lesson FTS hit counts for the question, scoped to one course. */
function countQuestionHits(db: Database, assetId: number, question: string): Map<number, number> {
  const tokens = question
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    .map((t) => `"${t}"*`);
  if (tokens.length === 0) return new Map();
  try {
    const rows = db
      .prepare(
        `SELECT c.file_id AS file_id, COUNT(*) AS n
           FROM transcript_fts t
           JOIN transcript_cues c ON c.id = t.rowid
           JOIN course_files f ON f.id = c.file_id
          WHERE transcript_fts MATCH ? AND f.asset_id = ?
          GROUP BY c.file_id`,
      )
      .all(tokens.join(' OR '), assetId) as { file_id: number; n: number }[];
    return new Map(rows.map((r) => [r.file_id, r.n]));
  } catch {
    // An FTS syntax corner case must degrade to course-order selection, not
    // kill the whole ask.
    return new Map();
  }
}
