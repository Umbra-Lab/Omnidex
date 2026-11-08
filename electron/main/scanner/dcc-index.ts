import type { Database } from 'better-sqlite3';
import { pruneAssetsNotIn } from '../db/repos/assets';
import { type DccFile, discoverDccFiles } from './dcc-discovery';

export async function scanDccLocation(
  db: Database,
  locationId: number,
  root: string,
  signal: AbortSignal,
): Promise<{ total: number; existing: number }> {
  const files = await discoverDccFiles(root, signal);
  signal.throwIfAborted();
  const existing = db.prepare('SELECT 1 FROM assets WHERE file_path = ?');
  const count = files.filter((file) => existing.get(file.path)).length;
  indexDccFiles(db, locationId, files);
  return { total: files.length, existing: count };
}

/** Commit a complete discovery atomically; never take ownership of another location's row. */
export function indexDccFiles(db: Database, locationId: number, files: DccFile[]): void {
  const owner = db.prepare('SELECT scan_location_id FROM assets WHERE file_path = ?');
  const upsert = db.prepare(`INSERT INTO assets
    (name, file_path, asset_type, file_size, file_size_is_partial, created_date, modified_date,
     scan_location_id, is_favorite, ecosystem, asset_ecosystem, content_format, scan_search_text)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, NULL, ?)
    ON CONFLICT(file_path) DO UPDATE SET name=excluded.name, asset_type=excluded.asset_type,
      file_size=excluded.file_size, modified_date=excluded.modified_date,
      ecosystem=excluded.ecosystem, asset_ecosystem=excluded.asset_ecosystem,
      scan_search_text=excluded.scan_search_text, missing_since=NULL`);
  db.exec('BEGIN');
  try {
    const now = new Date().toISOString();
    for (const file of files) {
      const existing = owner.get(file.path) as { scan_location_id: number } | undefined;
      if (existing && existing.scan_location_id !== locationId) {
        throw new Error(`Asset path belongs to another scan location: ${file.path}`);
      }
      const metadata =
        `${file.path} ${file.relativePath} ${file.ecosystem} ${file.kind} ${file.searchTerms ?? ''}`
          .replaceAll('_', ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2');
      const aliases = [
        /\b(?:woman|women|female)\b/i.test(metadata) ? 'woman female human' : '',
        /\b(?:man|men|male)\b/i.test(metadata) ? 'man male human' : '',
      ].join(' ');
      upsert.run(
        file.name,
        file.path,
        `dcc_${file.kind}`,
        file.size,
        now,
        now,
        locationId,
        file.ecosystem,
        file.ecosystem,
        `${metadata} ${aliases}`,
      );
    }
    pruneAssetsNotIn(
      db,
      locationId,
      files.map((file) => file.path),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
