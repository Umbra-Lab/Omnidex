import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listCourseFiles,
  replaceCourseManifest,
  replaceTranscript,
  searchTranscripts,
  setProgress,
  subtitlePathForVideo,
} from '../courses';
import { createTestDb, seedAsset } from './fixtures/test-db';

let db: Database;
let courseId: number;

const file = (relPath: string, kind: string, chapter: string | null, order = 0) => ({
  relPath,
  absPath: `C:/c/${relPath}`,
  kind,
  chapter,
  orderIndex: order,
  sizeBytes: 100,
  durationSeconds: kind === 'video' ? 60 : null,
});

beforeEach(() => {
  db = createTestDb();
  db.exec(`
    CREATE TABLE course_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL,
      rel_path TEXT NOT NULL, abs_path TEXT NOT NULL, kind TEXT NOT NULL,
      chapter TEXT, order_index INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0, duration_seconds REAL,
      UNIQUE (asset_id, rel_path),
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE);
    CREATE TABLE course_progress (
      file_id INTEGER PRIMARY KEY, position_seconds REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
      FOREIGN KEY (file_id) REFERENCES course_files(id) ON DELETE CASCADE);
    CREATE TABLE transcript_cues (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES course_files (id) ON DELETE CASCADE,
      start_ms INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE INDEX transcript_cues_file ON transcript_cues (file_id, start_ms);
    CREATE VIRTUAL TABLE transcript_fts USING fts5(
      text, content='transcript_cues', content_rowid='id', tokenize='porter unicode61');
    CREATE TRIGGER transcript_cues_ai AFTER INSERT ON transcript_cues BEGIN
      INSERT INTO transcript_fts (rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER transcript_cues_ad AFTER DELETE ON transcript_cues BEGIN
      INSERT INTO transcript_fts (transcript_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
  `);
  courseId = seedAsset(db, { name: 'Course', file_path: '/c', content_format: 'course' });
});

afterEach(() => {
  (db as unknown as { close: () => void }).close();
});

describe('listCourseFiles ordering', () => {
  it('sorts chapters numerically, not lexically', () => {
    replaceCourseManifest(db, courseId, [
      file('11 - Elevator/a.mp4', 'video', '11 - Elevator'),
      file('2 - Basics/a.mp4', 'video', '2 - Basics'),
      file('10 - Platform/a.mp4', 'video', '10 - Platform'),
      file('1 - Intro/a.mp4', 'video', '1 - Intro'),
    ]);
    // COLLATE NOCASE would give 1, 10, 11, 2 — which is what the app showed.
    expect(listCourseFiles(db, courseId).map((f) => f.chapter)).toEqual([
      '1 - Intro',
      '2 - Basics',
      '10 - Platform',
      '11 - Elevator',
    ]);
  });

  it('puts root-level files before any chapter', () => {
    replaceCourseManifest(db, courseId, [
      file('01 - Ch/a.mp4', 'video', '01 - Ch'),
      file('README.pdf', 'doc', null),
    ]);
    expect(listCourseFiles(db, courseId)[0].rel_path).toBe('README.pdf');
  });

  it('orders lessons inside a chapter by the author numbering', () => {
    replaceCourseManifest(db, courseId, [
      file('c/10 - Ten.mp4', 'video', 'c', 10),
      file('c/2 - Two.mp4', 'video', 'c', 2),
      file('c/1 - One.mp4', 'video', 'c', 1),
    ]);
    expect(listCourseFiles(db, courseId).map((f) => f.rel_path)).toEqual([
      'c/1 - One.mp4',
      'c/2 - Two.mp4',
      'c/10 - Ten.mp4',
    ]);
  });

  it('flags a video that has a subtitle sidecar with the same stem', () => {
    replaceCourseManifest(db, courseId, [
      file('c/01 - A.mp4', 'video', 'c'),
      file('c/01 - A.srt', 'subtitle', 'c'),
      file('c/02 - B.mp4', 'video', 'c'),
    ]);
    const byName = Object.fromEntries(listCourseFiles(db, courseId).map((f) => [f.rel_path, f]));
    expect(byName['c/01 - A.mp4'].has_subtitle).toBe(1);
    expect(byName['c/02 - B.mp4'].has_subtitle).toBe(0);
  });
});

describe('subtitlePathForVideo', () => {
  const videoId = () => listCourseFiles(db, courseId).find((f) => f.kind === 'video')?.id as number;

  it('prefers the English translation over the native sidecar', () => {
    // A Russian lesson Whisper transcribed to `.srt` and then translated to
    // `.en.srt`. Inserted native-first so DB order alone would pick the wrong one.
    replaceCourseManifest(db, courseId, [
      file('c/01 - A.mp4', 'video', 'c'),
      file('c/01 - A.mp4.srt', 'subtitle', 'c'),
      file('c/01 - A.mp4.en.srt', 'subtitle', 'c'),
    ]);
    expect(subtitlePathForVideo(db, videoId())).toBe('C:/c/c/01 - A.mp4.en.srt');
  });

  it('falls back to the only sidecar when there is no English one', () => {
    replaceCourseManifest(db, courseId, [
      file('c/01 - A.mp4', 'video', 'c'),
      file('c/01 - A.mp4.srt', 'subtitle', 'c'),
    ]);
    expect(subtitlePathForVideo(db, videoId())).toBe('C:/c/c/01 - A.mp4.srt');
  });

  it('returns null for a video with no sidecar', () => {
    replaceCourseManifest(db, courseId, [file('c/01 - A.mp4', 'video', 'c')]);
    expect(subtitlePathForVideo(db, videoId())).toBeNull();
  });
});

describe('transcript index', () => {
  const seedLesson = () => {
    replaceCourseManifest(db, courseId, [file('c/01 - A.mp4', 'video', 'c')]);
    return listCourseFiles(db, courseId)[0].id;
  };
  const hits = (q: string) => searchTranscripts(db, q).map((h) => h.text);

  it('indexes cues so they are searchable', () => {
    replaceTranscript(db, seedLesson(), [{ startMs: 0, text: 'enable Nanite on the mesh' }]);
    expect(hits('nanite')).toEqual(['enable Nanite on the mesh']);
  });

  it('drops the previous cues when a lesson is re-transcribed', () => {
    const id = seedLesson();
    replaceTranscript(db, id, [{ startMs: 0, text: 'the old wrong transcript' }]);
    replaceTranscript(db, id, [{ startMs: 0, text: 'the new correct transcript' }]);
    // An external-content index does not clean itself up; without the delete
    // trigger the stale row stays matchable forever.
    expect(hits('wrong')).toEqual([]);
    expect(hits('correct')).toEqual(['the new correct transcript']);
  });

  it('reclaims cues when the lesson is pruned', () => {
    replaceTranscript(db, seedLesson(), [{ startMs: 0, text: 'orphan me' }]);
    // A re-scan deletes and reinserts course_files rows, which reassigns their
    // ids. Cues used to live in a virtual table that could not carry a foreign
    // key, so every scan stranded the last one's cues — 60% of the live index.
    replaceCourseManifest(db, courseId, [file('c/02 - B.mp4', 'video', 'c')]);
    expect(hits('orphan')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_cues').get()).toEqual({ n: 0 });
  });
});

describe('replaceCourseManifest', () => {
  it('carries playback position across a re-scan', () => {
    replaceCourseManifest(db, courseId, [file('c/01 - A.mp4', 'video', 'c')]);
    const id = listCourseFiles(db, courseId)[0].id;
    setProgress(db, id, 42.5, false);

    // Re-scan rebuilds the manifest; how far you got must survive it.
    replaceCourseManifest(db, courseId, [
      file('c/01 - A.mp4', 'video', 'c'),
      file('c/02 - B.mp4', 'video', 'c'),
    ]);
    const again = listCourseFiles(db, courseId).find((f) => f.rel_path === 'c/01 - A.mp4');
    expect(again?.position_seconds).toBe(42.5);
  });
});
