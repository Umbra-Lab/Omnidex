import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteNote, getNoteForAsset, upsertNote } from '../notes';

/**
 * The `asset_notes` columns from
 * `migrations/20260127180000_create_asset_notes_table.up.sql`. The shared
 * fixture drops `tested_ue_versions` and `reminders`, which are exactly what
 * these tests are about.
 */
const SCHEMA = /* sql */ `
CREATE TABLE asset_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  note_text TEXT,
  rating REAL CHECK(rating IS NULL OR (rating >= 0.0 AND rating <= 5.0)),
  tested_ue_versions TEXT,
  reminders TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

let raw: DatabaseSync;
let db: Database;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  db = raw as unknown as Database;
});

afterEach(() => {
  raw.close();
});

describe('upsertNote', () => {
  it('creates a note, then replaces its text and rating', () => {
    upsertNote(db, { asset_id: 1, note_text: 'first', rating: 3 });
    const updated = upsertNote(db, { asset_id: 1, note_text: null, rating: 4.5 });
    expect(updated.note_text).toBeNull();
    expect(updated.rating).toBe(4.5);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM asset_notes').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('keeps stored lists when a text or rating edit omits them', () => {
    // The Unity ownership merge carries these lists over; the inspector only
    // edits text and rating, and used to send null for both lists.
    upsertNote(db, {
      asset_id: 7,
      note_text: 'old',
      rating: null,
      tested_ue_versions: ['5.3', '5.4'],
      reminders: ['check LODs'],
    });
    const edited = upsertNote(db, { asset_id: 7, note_text: 'new', rating: 2 });
    expect(edited.note_text).toBe('new');
    expect(JSON.parse(edited.tested_ue_versions ?? 'null')).toEqual(['5.3', '5.4']);
    expect(JSON.parse(edited.reminders ?? 'null')).toEqual(['check LODs']);
  });

  it('clears a list only when the caller sends null or an empty array', () => {
    upsertNote(db, {
      asset_id: 2,
      note_text: null,
      rating: 1,
      tested_ue_versions: ['5.1'],
      reminders: ['a'],
    });
    const cleared = upsertNote(db, {
      asset_id: 2,
      note_text: null,
      rating: 1,
      tested_ue_versions: null,
      reminders: [],
    });
    expect(cleared.tested_ue_versions).toBeNull();
    expect(cleared.reminders).toBeNull();
  });

  it('starts a new note with no lists when none are sent', () => {
    const created = upsertNote(db, { asset_id: 3, note_text: 'hi', rating: null });
    expect(created.tested_ue_versions).toBeNull();
    expect(created.reminders).toBeNull();
  });
});

describe('deleteNote', () => {
  it('removes the note for that asset only', () => {
    upsertNote(db, { asset_id: 1, note_text: 'a', rating: null });
    upsertNote(db, { asset_id: 2, note_text: 'b', rating: null });
    deleteNote(db, 1);
    expect(getNoteForAsset(db, 1)).toBeNull();
    expect(getNoteForAsset(db, 2)?.note_text).toBe('b');
  });
});
