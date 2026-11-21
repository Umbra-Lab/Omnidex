import { relative, sep } from 'node:path';
import type { Database } from 'better-sqlite3';

/**
 * One file shown twice is worse than one shown once. When a DCC location and a Unity
 * location both reach a Unity project, the Unity entry wins: the DCC scan leaves files
 * inside a Unity project or `.unitypackage` alone, and rows it made there before are
 * folded into the Unity entry. What the person added to those rows (collections, tags,
 * notes, favourite) moves onto the Unity entry, and the file's name, kind and tool stay
 * searchable through it (see `dccSearchTerms` in `index.ts`).
 *
 * Only what Unity owns is claimed: a project's Assets/, Packages/ and the folders the
 * Editor generates. A Unity project with no Unity location over it has no Unity entry,
 * so its DCC rows stay as they are.
 */
export interface UnityClaim {
  id: number;
  path: string;
  /** A project claims its Unity folders (see `covers`); a package claims its own file. */
  folder: boolean;
}

/** Every Unity project, Assets folder and package currently indexed. */
export function unityClaims(db: Database): UnityClaim[] {
  const rows = db
    .prepare(
      `SELECT id, file_path, asset_type FROM assets
        WHERE asset_type IN ('unity_project', 'unity_package') AND missing_since IS NULL`,
    )
    .all() as Array<{ id: number; file_path: string; asset_type: string }>;
  return rows.map((row) => ({
    id: row.id,
    path: row.file_path,
    folder: row.asset_type === 'unity_project',
  }));
}

/**
 * The folders of a project that are Unity's: what the Unity scan indexes (Assets/,
 * Packages/) and what the Editor generates. A `.blend` kept in `Source/` beside them is
 * not in the Unity index, so it stays a DCC file.
 */
const UNITY_FOLDERS = new Set([
  'assets',
  'packages',
  'library',
  'temp',
  'logs',
  'obj',
  'usersettings',
]);

function covers(claim: UnityClaim, path: string): boolean {
  if (path === claim.path) return true;
  if (!claim.folder || !path.startsWith(claim.path + sep)) return false;
  const first = path.slice(claim.path.length + 1).split(sep, 1)[0];
  return UNITY_FOLDERS.has(first.toLowerCase());
}

/** The innermost claim over `path`, so a chapter's Assets folder wins over its course. */
export function claimOf(path: string, claims: UnityClaim[]): UnityClaim | undefined {
  let best: UnityClaim | undefined;
  for (const claim of claims) {
    if (covers(claim, path) && (!best || claim.path.length > best.path.length)) best = claim;
  }
  return best;
}

/**
 * Fold every DCC row inside a Unity claim into that claim's entry, then delete it.
 * Runs inside the caller's transaction. Returns how many DCC rows were folded.
 */
export function foldDccRowsIntoUnity(db: Database, claims: UnityClaim[]): number {
  if (claims.length === 0) return 0;
  const rows = db
    .prepare(
      `SELECT id, file_path, is_favorite FROM assets
        WHERE asset_type GLOB 'dcc_*'`,
    )
    .all() as Array<{ id: number; file_path: string; is_favorite: number }>;
  const toFold = rows.flatMap((row) => {
    const claim = claimOf(row.file_path, claims);
    return claim && claim.id !== row.id ? [{ row, claim }] : [];
  });
  if (toFold.length === 0) return 0;
  const moveCollections = db.prepare(
    `INSERT OR IGNORE INTO collection_items (collection_id, asset_id, added_at, sort_order)
       SELECT collection_id, ?, added_at, sort_order FROM collection_items WHERE asset_id = ?`,
  );
  const moveTags = db.prepare(
    `INSERT INTO asset_tags (asset_id, tag, tag_type, confidence, source, created_at)
       SELECT ?1, t.tag, t.tag_type, t.confidence, t.source, t.created_at
         FROM asset_tags t
        WHERE t.asset_id = ?2
          AND NOT EXISTS (SELECT 1 FROM asset_tags u WHERE u.asset_id = ?1 AND u.tag = t.tag)`,
  );
  const allTags = db.prepare('SELECT DISTINCT tag FROM asset_tags WHERE asset_id = ?');
  const setTags = db.prepare('UPDATE assets SET tags = ? WHERE id = ?');
  const noteOf = db.prepare(
    'SELECT note_text, rating, reminders FROM asset_notes WHERE asset_id = ? ORDER BY id LIMIT 1',
  );
  const appendNote = db.prepare(
    `UPDATE asset_notes SET note_text = ?, reminders = ?, updated_at = ? WHERE asset_id = ?`,
  );
  const addNote = db.prepare(
    `INSERT INTO asset_notes (asset_id, note_text, reminders, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
  );
  const favourite = db.prepare('UPDATE assets SET is_favorite = 1 WHERE id = ?');
  const remove = db.prepare('DELETE FROM assets WHERE id = ?');

  let folded = 0;
  for (const { row, claim } of toFold) {
    const label = claim.folder ? relative(claim.path, row.file_path) : row.file_path;

    moveCollections.run(claim.id, row.id);
    if (moveTags.run(claim.id, row.id).changes > 0) {
      const tags = (allTags.all(claim.id) as Array<{ tag: string }>).map((t) => t.tag);
      setTags.run(JSON.stringify(tags), claim.id);
    }
    const note = noteOf.get(row.id) as
      | { note_text: string | null; rating: number | null; reminders: string | null }
      | undefined;
    if (note && (note.note_text || note.rating !== null || note.reminders)) {
      // One note per entry: the file's note is appended under its path, rating included,
      // so nothing typed is lost and the project's own rating is not overwritten.
      const rated = note.rating !== null ? ` (rated ${note.rating}/5)` : '';
      const text = `${label}${rated}: ${note.note_text ?? ''}`.trimEnd();
      const target = noteOf.get(claim.id) as
        | { note_text: string | null; reminders: string | null }
        | undefined;
      const reminders = mergeJsonLists(target?.reminders ?? null, note.reminders);
      const now = new Date().toISOString();
      if (target) {
        const merged = target.note_text ? `${target.note_text}\n\n${text}` : text;
        appendNote.run(merged, reminders, now, claim.id);
      } else {
        addNote.run(claim.id, text, reminders, now, now);
      }
    }
    if (row.is_favorite) favourite.run(claim.id);
    remove.run(row.id);
    folded += 1;
  }
  return folded;
}

function mergeJsonLists(a: string | null, b: string | null): string | null {
  const parse = (text: string | null): unknown[] => {
    if (!text) return [];
    try {
      const value = JSON.parse(text);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const merged = [...new Set([...parse(a), ...parse(b)])];
  return merged.length > 0 ? JSON.stringify(merged) : null;
}
