#!/usr/bin/env node
/**
 * Write a starter oracle-golden.json for golden.mjs from your own library, so scoring does
 * not wait on someone typing thirty queries. Run:
 *
 *   node scripts/oracle-mcp/golden-gen.mjs [path-to-omnidex.db] [--force]
 *
 * Picks the most popular packs you own (most Orbital/FAB ratings first, then Unity packages
 * and the largest remaining packs) and, for each, writes the queries that used to fail:
 *
 *   - a word hidden inside a joined-up name ("corridor" for ModularSciFiCorridor)
 *   - the start of a word ("corri")
 *   - a typo (two letters swapped: "corirdor")
 *   - a question ("do I have a sci fi corridor pack")
 *
 * plus questions built from real transcript cues ("how do I" + the cue's three rarest words).
 * Every expected answer is something the library holds, because a popular marketplace pack
 * you do not own can never be a correct result.
 *
 * Generated queries test the failure modes this search was built for; they are not a
 * substitute for real ones. Add your own to the file as you hit misses.
 *
 * Opens the database read-only. Writes oracle-golden.json next to it, unless one exists
 * (pass --force to replace it).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dbPath =
  args.find((a) => !a.startsWith('--')) ??
  process.env.ORACLE_DB ??
  join(process.env.APPDATA ?? '.', 'omnidex', 'omnidex.db');
const outPath = join(dirname(dbPath), 'oracle-golden.json');
const PACKS = 25;
const CUES = 15;

if (existsSync(outPath) && !force) {
  console.error(`${outPath} exists; pass --force to replace it.`);
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

/** Same splitting as electron/main/scanner/search-text.ts, without the joined pairs. */
function words(name) {
  return name
    .replaceAll(/[_./@()[\]-]/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]{4,}$/.test(w));
}

// Seeded so a rerun on the same library writes the same file.
let seed = 1;
function rand(n) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
}

const STOP = new Set(
  'that this with from have your what when then they them there just like going really about into'.split(
    ' ',
  ),
);

const packs = db
  .prepare(`
    SELECT name FROM assets
    WHERE content_format IS NULL AND missing_since IS NULL
      AND asset_type NOT GLOB 'dcc_*' AND asset_type <> 'unity_project'
      AND (asset_type NOT GLOB 'unity_*' OR asset_type = 'unity_package')
    ORDER BY COALESCE(orbital_rating_count, 0) DESC,
             (asset_type = 'unity_package') DESC,
             file_size DESC
    LIMIT 200`)
  .all();

// Distinct pack names containing a word (LIKE folds ASCII case). Copies of one pack in
// several folders share a name, so they count once.
const sharingStmt = db.prepare(`
  SELECT COUNT(DISTINCT lower(name)) AS n FROM assets
  WHERE content_format IS NULL AND missing_since IS NULL
    AND (name LIKE ?1 ESCAPE '\\' OR orbital_title LIKE ?1 ESCAPE '\\')`);

const golden = [];
const seen = new Set();
for (const { name } of packs) {
  if (golden.length >= PACKS * 4) break;
  const ws = words(name).filter((w) => !new RegExp(`[A-Z]${w}`).test(name));
  if (ws.length === 0) continue;
  const key = ws.join(' ').toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  const longest = ws.reduce((a, b) => (b.length > a.length ? b : a));
  const add = (kind, query) => golden.push({ tool: 'search_assets', kind, query, expect: name });
  // A one-word query is only a fair test when that word picks out this pack. "narrative"
  // names a dozen packs in a library that owns the whole Narrative line, so any of them is
  // a right answer and scoring one of them would count correct results as misses.
  // A word split off an acronym run is a guess: "rdLODtools" splits to "LO Dtools", and
  // nobody types "dtools". Leave such words out rather than test the splitter's guess.
  const guessed = new RegExp(`[A-Z]${longest}`).test(name);
  const unique = !guessed && sharingStmt.get(`%${longest}%`).n <= 2;
  // Only a joined-up name has a hidden word worth testing on its own.
  if (unique && !new RegExp(`(^|[^A-Za-z])${longest}([^A-Za-z]|$)`).test(name)) {
    add('hidden word', longest.toLowerCase());
  }
  if (unique && longest.length >= 6) {
    // The start must pick out the pack too: "brush" (for Brushify) names a hundred
    // brushed materials, so any of them is a right answer.
    const start = longest.slice(0, Math.ceil(longest.length * 0.6)).toLowerCase();
    if (sharingStmt.get(`%${start}%`).n <= 2) add('word start', start);
    const i = 1 + rand(longest.length - 3);
    const typo = longest.slice(0, i) + longest[i + 1] + longest[i] + longest.slice(i + 2);
    if (typo.toLowerCase() !== longest.toLowerCase()) add('typo', typo.toLowerCase());
  }
  // "Blood_VFX_Pack" asks for a "blood pack", not a "blood pack pack".
  const named = ws.filter((w) => !/^(packs?|assets?)$/i.test(w));
  if (named.length > 0) add('question', `do I have a ${named.join(' ').toLowerCase()} pack`);
}

// Cues from across the corpus: rowids spread evenly, so one long course does not dominate.
let cueCount = 0;
try {
  const { n, lo, hi } = db
    .prepare('SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM transcript_cues')
    .get();
  const cueStmt = db.prepare('SELECT text FROM transcript_cues WHERE id >= ? LIMIT 1');
  // How many cues hold a word, counted up to a cap so a common word stays cheap.
  const freqStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM (SELECT 1 FROM transcript_fts WHERE transcript_fts MATCH ? LIMIT 20000)',
  );
  const freq = (w) => freqStmt.get(`"${w}"`).n;
  for (let k = 0; n > 0 && k < CUES * 4 && cueCount < CUES; k++) {
    const row = cueStmt.get(lo + Math.floor(((hi - lo) * (k + 0.5)) / (CUES * 4)));
    if (!row) continue;
    const content = String(row.text)
      .split(/\s+/)
      .map((w) => w.replaceAll(/[^A-Za-z]/g, '').toLowerCase())
      .filter((w) => w.length >= 4 && !STOP.has(w));
    if (content.length < 3) continue;
    // The three rarest words, kept in spoken order. The first three were often filler
    // ("need", "want", "okay") that a thousand cues share, so no search could pick the
    // right one and the query measured nothing.
    const uniq = [...new Set(content)];
    if (uniq.length < 3) continue;
    const rare = new Set(
      uniq
        .map((w) => ({ w, n: freq(w) }))
        .sort((a, b) => a.n - b.n)
        .slice(0, 3)
        .map((x) => x.w),
    );
    const pick = uniq.filter((w) => rare.has(w));
    golden.push({
      tool: 'search_transcripts',
      kind: 'question',
      query: `how do I ${pick.join(' ')}`,
      expect: String(row.text).trim().slice(0, 40),
    });
    cueCount++;
  }
} catch {
  // No transcripts in this library: asset queries only.
}

writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
console.log(
  `Wrote ${golden.length} queries (${golden.length - cueCount} asset, ${cueCount} transcript) to ${outPath}`,
);
console.log('Score them with: node scripts/oracle-mcp/golden.mjs');
