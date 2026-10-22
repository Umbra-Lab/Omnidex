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
  const testedJson = req.tested_ue_versions ? JSON.stringify(req.tested_ue_versions) : null;
  const remindersJson = req.reminders ? JSON.stringify(req.reminders) : null;

  const existing = getNoteForAsset(db, req.asset_id);

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
