import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { assembleCourseContext } from '../context';

/**
 * In-memory fixture mirroring the course slice of the schema: `course_files`
 * (migration 20260731010000) and the `transcript_fts` FTS5 table, driven
 * through node:sqlite exactly like the repo tests.
 */

const SCHEMA = /* sql */ `
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  display_title TEXT
);
CREATE TABLE course_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  abs_path TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  chapter TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL
);
CREATE TABLE transcript_cues (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES course_files (id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX transcript_cues_file ON transcript_cues (file_id, start_ms);
CREATE VIRTUAL TABLE transcript_fts USING fts5(
  text, content='transcript_cues', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER transcript_cues_ai AFTER INSERT ON transcript_cues BEGIN
  INSERT INTO transcript_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER transcript_cues_ad AFTER DELETE ON transcript_cues BEGIN
  INSERT INTO transcript_fts (transcript_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

interface SeedFile {
  relPath: string;
  kind: 'video' | 'subtitle';
  chapter?: string | null;
  orderIndex?: number;
  cues?: { startMs: number; text: string }[];
}

function makeDb(files: SeedFile[]): { db: Database; ids: Map<string, number> } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  raw.prepare('INSERT INTO assets (id, name) VALUES (1, ?)').run('Test Course');
  const insertFile = raw.prepare(
    'INSERT INTO course_files (asset_id, rel_path, kind, chapter, order_index) VALUES (1, ?, ?, ?, ?)',
  );
  const insertCue = raw.prepare(
    'INSERT INTO transcript_cues (text, file_id, start_ms) VALUES (?, ?, ?)',
  );
  const ids = new Map<string, number>();
  for (const f of files) {
    const id = Number(
      insertFile.run(f.relPath, f.kind, f.chapter ?? null, f.orderIndex ?? 0).lastInsertRowid,
    );
    ids.set(f.relPath, id);
    for (const cue of f.cues ?? []) insertCue.run(cue.text, id, cue.startMs);
  }
  return { db: raw as unknown as Database, ids };
}

const cue = (startMs: number, text: string) => ({ startMs, text });

describe('assembleCourseContext', () => {
  it('returns null when the course has no cues', () => {
    const { db } = makeDb([{ relPath: '1/lesson.mp4', kind: 'video' }]);
    expect(assembleCourseContext(db, 1, 100_000, 'anything')).toBeNull();
  });

  it('orders lessons numerically and headers carry the citable lesson_id', () => {
    const { db, ids } = makeDb([
      { relPath: '10 - Later/a.mp4', kind: 'video', chapter: '10 - Later', orderIndex: 1 },
      {
        relPath: '10 - Later/a.srt',
        kind: 'subtitle',
        chapter: '10 - Later',
        orderIndex: 1,
        cues: [cue(0, 'later chapter speech')],
      },
      { relPath: '2 - Early/b.mp4', kind: 'video', chapter: '2 - Early', orderIndex: 1 },
      {
        relPath: '2 - Early/b.srt',
        kind: 'subtitle',
        chapter: '2 - Early',
        orderIndex: 1,
        cues: [cue(0, 'early chapter speech')],
      },
    ]);
    const ctx = assembleCourseContext(db, 1, 100_000, 'speech');
    expect(ctx).not.toBeNull();
    expect(ctx?.mode).toBe('full');
    const early = ctx?.text.indexOf('early chapter speech') ?? -1;
    const later = ctx?.text.indexOf('later chapter speech') ?? -1;
    expect(early).toBeGreaterThanOrEqual(0);
    expect(early).toBeLessThan(later);
    expect(ctx?.text).toContain(`(lesson_id=${ids.get('2 - Early/b.srt')})`);
    // The video pairing survives into the citation map.
    const lesson = ctx?.lessons.find((l) => l.lessonId === ids.get('2 - Early/b.srt'));
    expect(lesson?.videoFileId).toBe(ids.get('2 - Early/b.mp4'));
  });

  it('picks one subtitle per lesson, preferring English over translation folders', () => {
    const { db, ids } = makeDb([
      { relPath: 'A/lesson.mp4', kind: 'video', chapter: 'A' },
      {
        relPath: 'A/_/lesson.ar.srt',
        kind: 'subtitle',
        chapter: 'A',
        cues: [cue(0, 'arabic text here')],
      },
      {
        relPath: 'A/lesson.mp4.srt',
        kind: 'subtitle',
        chapter: 'A',
        cues: [cue(0, 'whisper sidecar text')],
      },
      {
        relPath: 'A/lesson.English.srt',
        kind: 'subtitle',
        chapter: 'A',
        cues: [cue(0, 'english subtitle text')],
      },
    ]);
    const ctx = assembleCourseContext(db, 1, 100_000, 'text');
    expect(ctx?.includedCount).toBe(1);
    expect(ctx?.text).toContain('english subtitle text');
    expect(ctx?.text).not.toContain('arabic text here');
    expect(ctx?.text).not.toContain('whisper sidecar text');
    expect(ctx?.lessons[0]?.lessonId).toBe(ids.get('A/lesson.English.srt'));
    expect(ctx?.lessons[0]?.videoFileId).toBe(ids.get('A/lesson.mp4'));
  });

  it('adds a timestamp marker roughly once a minute', () => {
    const { db } = makeDb([
      {
        relPath: 'l.srt',
        kind: 'subtitle',
        cues: [
          cue(1_000, 'first minute'),
          cue(30_000, 'still first'),
          cue(65_000, 'second minute'),
        ],
      },
    ]);
    const ctx = assembleCourseContext(db, 1, 100_000, 'minute');
    expect(ctx?.text).toContain('[0:01] first minute');
    expect(ctx?.text).toContain('[1:05] second minute');
    expect(ctx?.text).not.toContain('[0:30]');
  });

  it('falls back to a question-scoped subset when over budget', () => {
    const filler = (word: string) =>
      Array.from({ length: 40 }, (_, i) => cue(i * 5_000, `${word} sentence number ${i}`));
    const { db, ids } = makeDb([
      { relPath: '1/a.srt', kind: 'subtitle', chapter: '1', cues: filler('landscape') },
      { relPath: '2/b.srt', kind: 'subtitle', chapter: '2', cues: filler('niagara ribbon') },
      { relPath: '3/c.srt', kind: 'subtitle', chapter: '3', cues: filler('lighting') },
    ]);
    // Budget fits roughly one lesson.
    const ctx = assembleCourseContext(db, 1, 500, 'niagara ribbon emitter');
    expect(ctx?.mode).toBe('scoped');
    expect(ctx?.lessonCount).toBe(3);
    expect(ctx?.includedCount).toBeLessThan(3);
    expect(ctx?.lessons.map((l) => l.lessonId)).toContain(ids.get('2/b.srt'));
    expect(ctx?.text).toContain('niagara');
  });

  it('collapses the space-separated language names the live library uses', () => {
    const { db, ids } = makeDb([
      { relPath: 'C1/2 Welcome to the Course.mp4', kind: 'video', chapter: 'C1' },
      {
        relPath: 'C1/2 Welcome to the Course.srt',
        kind: 'subtitle',
        chapter: 'C1',
        cues: [cue(0, 'welcome in english')],
      },
      {
        relPath: 'C1/2 Welcome to the Course Simplified Chinese.srt',
        kind: 'subtitle',
        chapter: 'C1',
        cues: [cue(0, '欢迎课程内容')],
      },
      {
        relPath: 'C1/2 Welcome to the Course Dutch.srt',
        kind: 'subtitle',
        chapter: 'C1',
        cues: [cue(0, 'welkom bij de cursus')],
      },
    ]);
    const ctx = assembleCourseContext(db, 1, 100_000, 'welcome');
    expect(ctx?.includedCount).toBe(1);
    expect(ctx?.text).toContain('welcome in english');
    expect(ctx?.text).not.toContain('welkom');
    expect(ctx?.lessons[0]?.videoFileId).toBe(ids.get('C1/2 Welcome to the Course.mp4'));
  });

  it('renders hour-long timestamps unambiguously', () => {
    const { db } = makeDb([
      {
        relPath: 'long.srt',
        kind: 'subtitle',
        cues: [cue(0, 'start'), cue(4_503_000, 'seventy five minutes in')],
      },
    ]);
    const ctx = assembleCourseContext(db, 1, 100_000, 'start');
    expect(ctx?.text).toContain('[1:15:03] seventy five minutes in');
    expect(ctx?.text).not.toContain('[75:03]');
  });

  it('ignores stop words when scoping to the question', () => {
    const filler = (word: string) =>
      Array.from({ length: 40 }, (_, i) => cue(i * 5_000, `${word} how do you use it ${i}`));
    const { db, ids } = makeDb([
      { relPath: '1/chatty.srt', kind: 'subtitle', chapter: '1', cues: filler('turret') },
      { relPath: '2/install.srt', kind: 'subtitle', chapter: '2', cues: filler('install engine') },
    ]);
    // "how do you use" is pure stop words; only "install" may drive the pick.
    const ctx = assembleCourseContext(db, 1, 400, 'how do you install');
    expect(ctx?.mode).toBe('scoped');
    expect(ctx?.lessons.map((l) => l.lessonId)).toContain(ids.get('2/install.srt'));
    expect(ctx?.lessons.map((l) => l.lessonId)).not.toContain(ids.get('1/chatty.srt'));
  });

  it('never returns an empty scoped context', () => {
    const { db } = makeDb([
      {
        relPath: 'big.srt',
        kind: 'subtitle',
        cues: Array.from({ length: 200 }, (_, i) => cue(i * 3_000, `word${i} `.repeat(20))),
      },
    ]);
    // Budget smaller than the single lesson, question matching nothing.
    const ctx = assembleCourseContext(db, 1, 100, 'zzzunmatchable');
    expect(ctx?.includedCount).toBe(1);
    expect((ctx?.text.length ?? 0) > 0).toBe(true);
  });
});
