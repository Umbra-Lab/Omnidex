import type { AssetNote, NoteRequest } from '@omnidex/types/db';
import type { Database } from 'better-sqlite3';
import { normalizeRow } from './row-helpers';

export function getNoteForAsset(db: Database, assetId: number): AssetNote | null {
  const row = db.prepare('SELECT * FROM asset_notes WHERE asset_id = ?').get(assetId) as
    | Record<string, unknown>
    | undefined;
  return normalizeRow<AssetNote>(row);
}

export function upsertNote(db: Database, req: NoteRequest): AssetNote {
  const now = new Date().toISOString();
  const existing = getNoteForAsset(db, req.asset_id);
  // An omitted list keeps the stored one; only an explicit array or null
  // replaces it. A text or rating edit must not erase lists it never showed.
  const testedJson =
    req.tested_ue_versions === undefined
      ? (existing?.tested_ue_versions ?? null)
      : toJsonList(req.tested_ue_versions);
  const remindersJson =
    req.reminders === undefined ? (existing?.reminders ?? null) : toJsonList(req.reminders);

  if (existing) {
    db.prepare(
      `UPDATE asset_notes
       SET note_text = ?, rating = ?, tested_ue_versions = ?, reminders = ?, updated_at = ?
       WHERE asset_id = ?`,
    ).run(req.note_text, req.rating, testedJson, remindersJson, now, req.asset_id);
  } else {
    db.prepare(
      `INSERT INTO asset_notes (
        asset_id, note_text, rating, tested_ue_versions, reminders, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(req.asset_id, req.note_text, req.rating, testedJson, remindersJson, now, now);
  }

  const updated = getNoteForAsset(db, req.asset_id);
  if (!updated) {
    throw new Error(`Note upsert failed for asset ${req.asset_id}`);
  }
  return updated;
}

export function deleteNote(db: Database, assetId: number): void {
  db.prepare('DELETE FROM asset_notes WHERE asset_id = ?').run(assetId);
}

function toJsonList(list: string[] | null): string | null {
  return list && list.length > 0 ? JSON.stringify(list) : null;
}
