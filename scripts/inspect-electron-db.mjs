// Smoke-check: verify Electron-created DB has expected tables + migration count.
// Run via `pnpm inspect-db` — uses Electron's Node runtime so the
// native better-sqlite3 binding matches the one the main process loads.

import { join } from 'node:path';
import Database from 'better-sqlite3';

const userData = process.env.ELECTRON_USER_DATA ?? join(process.env.APPDATA ?? '', 'omnidex');
const dbFile = join(userData, 'omnidex.db');

const db = new Database(dbFile, { readonly: true });

const migrationCount = db.prepare('SELECT COUNT(*) AS n FROM _omnidex_migrations').get();

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((row) => row.name);

const assetColumnCount = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('assets')").get();

console.log(`db: ${dbFile}`);
console.log(`migrations applied: ${migrationCount.n}`);
console.log(`tables (${tables.length}): ${tables.join(', ')}`);
console.log(`assets columns: ${assetColumnCount.n}`);

db.close();
