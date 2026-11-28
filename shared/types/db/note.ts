/**
 * Asset notes and ratings. Ported from `src-tauri/src/models/note.rs`.
 */
export interface AssetNote {
  id: number | null;
  asset_id: number;
  note_text: string | null;
  /** 0.0 to 5.0, supports half-stars. */
  rating: number | null;
  /** JSON-encoded string array of tested UE versions. */
  tested_ue_versions: string | null;
  /** JSON-encoded string array of reminders. */
  reminders: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface NoteRequest {
  asset_id: number;
  note_text: string | null;
  rating: number | null;
  /**
   * Omit to keep the stored list. The inspector edits only text and rating,
   * and used to send null here, which erased lists the Unity ownership merge
   * had carried over.
   */
  tested_ue_versions?: string[] | null;
  /** Omit to keep the stored list (see `tested_ue_versions`). */
  reminders?: string[] | null;
}
