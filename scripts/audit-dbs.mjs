// Inventory every SQLite file under %APPDATA% that looks like Omnidex.
// Reports scan_locations + asset counts per DB so we can identify the one
// containing the user's ~1300-asset library.
//
// Runs as an Electron main-process script that writes its report to
// `tests/.shots/db-audit.txt` and then exits. We use Electron because
// better-sqlite3 was rebuilt against its ABI; plain Node would reject the
// native binding.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { app } from 'electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname);
const REPORT_PATH = join(REPO_ROOT, 'tests', '.shots', 'db-audit.txt');
mkdirSync(dirname(REPORT_PATH), { recursive: true });

const APPDATA = process.env.APPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Roaming');

const CANDIDATES = [
  join(APPDATA, 'Omnidex', 'omnidex.db'),
  join(APPDATA, 'Electron', 'omnidex.db'),
  join(APPDATA, 'com.omnidex.app', 'omnidex.db'),
  join(APPDATA, 'com.omnidex.desktop', 'omnidex.db'),
  join(APPDATA, 'omnidex', 'omnidex.db'),
];

const lines = [];
const log = (s) => lines.push(String(s));

app.whenReady().then(() => {
  for (const path of CANDIDATES) {
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    log(`\n=== ${path} (${(size / 1024).toFixed(1)} KB) ===`);
    try {
      const db = new Database(path, { readonly: true });
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all()
          .map((r) => r.name);
        log(`tables: ${tables.join(', ')}`);

        if (tables.includes('scan_locations')) {
          const locs = db
            .prepare('SELECT id, name, path, is_active, last_scan FROM scan_locations')
            .all();
          log(`scan_locations (${locs.length}):`);
          for (const l of locs)
            log(
              `  [${l.id}] ${l.name} -> ${l.path}  (active=${l.is_active}, last_scan=${l.last_scan ?? 'never'})`,
            );
        }

        if (tables.includes('assets')) {
          const total = db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
          log(`assets: ${total}`);
          if (total > 0) {
            const byType = db
              .prepare(
                'SELECT asset_type, COUNT(*) AS n FROM assets GROUP BY asset_type ORDER BY n DESC LIMIT 10',
              )
              .all();
            for (const row of byType) log(`  ${row.asset_type}: ${row.n}`);
            const sample = db.prepare('SELECT name, file_path FROM assets LIMIT 5').all();
            log('  sample:');
            for (const s of sample) log(`    ${s.name} @ ${s.file_path}`);
          }
        }
      } finally {
        db.close();
      }
    } catch (err) {
      log(`ERROR: ${err.message}`);
    }
  }

  log('\n=== done ===');
  writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
  app.quit();
});
