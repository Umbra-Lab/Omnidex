import { join } from 'node:path';
import { app } from 'electron';

/**
 * Electron userData directory for Omnidex.
 *
 * Phase 4 of the migration plan relocates the Tauri bundle identifier
 * (`com.omnidex.app`) to the new Electron app name (`Omnidex`). During
 * co-existence, this returns Electron's own userData path, which is distinct
 * from the Tauri path — the two runtimes do NOT share a database.
 *
 * A one-shot migrator in Phase 4 copies Tauri data into the Electron path.
 */
export function userDataDir(): string {
  return app.getPath('userData');
}

export function dbPath(): string {
  return join(userDataDir(), 'omnidex.db');
}

export function thumbnailsDir(): string {
  return join(userDataDir(), 'thumbnails');
}

export function searchIndexDir(): string {
  return join(userDataDir(), 'search_index');
}
