// Measure FTS5 search latency against one Omnidex DB, running the exact query
// the app runs (query.mjs is mirrored 1:1 from assets.ts).
//
// Two timings per sample, both honest and both reported:
//   - prepExec : db.prepare(sql).all(...)  — app-faithful. searchAssets() calls
//                db.prepare() fresh on every keystroke, so this is the real
//                per-search cost a user pays (compile + execute + materialize).
//   - execOnly : prepare once, time only .all(...) — isolates the query engine
//                from SQLite's statement compiler.
//
// Latency unit is the full result set for LIMIT 100, OFFSET 0 (DEFAULT_LIMIT).

import { createRequire } from 'node:module';
import { buildFtsQuery, DEFAULT_LIMIT, QUERY_SUITE, SEARCH_SQL } from './query.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const NS_PER_MS = 1e6;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    mean: sum / s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    min: s[0],
    max: s[s.length - 1],
  };
}

export function benchDb(dbPath, { iters = 500, warmup = 50, label = dbPath } = {}) {
  const db = new Database(dbPath, { readonly: true });
  const sqliteVersion = db.prepare('select sqlite_version() v').get().v;
  const assetCount = db.prepare('SELECT COUNT(*) c FROM assets').get().c;

  function measureQuery(raw) {
    const fts = buildFtsQuery(raw);
    const stmt = db.prepare(SEARCH_SQL);
    const rowCount = stmt.all(fts, DEFAULT_LIMIT, 0).length;

    for (let i = 0; i < warmup; i++) stmt.all(fts, DEFAULT_LIMIT, 0); // prime cache

    const prep = new Array(iters);
    const exec = new Array(iters);
    for (let i = 0; i < iters; i++) {
      const a = process.hrtime.bigint();
      db.prepare(SEARCH_SQL).all(fts, DEFAULT_LIMIT, 0); // fresh compile (app-faithful)
      const b = process.hrtime.bigint();
      stmt.all(fts, DEFAULT_LIMIT, 0); // pre-compiled (execute only)
      const c = process.hrtime.bigint();
      prep[i] = Number(b - a) / NS_PER_MS;
      exec[i] = Number(c - b) / NS_PER_MS;
    }
    return { raw, fts, rowCount, prep, exec };
  }

  const perQuery = [];
  const catStats = {};
  const allPrep = [];
  const allExec = [];

  for (const [cat, queries] of Object.entries(QUERY_SUITE)) {
    const catPrep = [];
    const catExec = [];
    for (const q of queries) {
      const { raw, fts, rowCount, prep, exec } = measureQuery(q);
      perQuery.push({
        category: cat,
        raw,
        fts,
        rowCount,
        prepExec: stats(prep),
        execOnly: stats(exec),
      });
      catPrep.push(...prep);
      catExec.push(...exec);
    }
    catStats[cat] = { queries: queries.length, prepExec: stats(catPrep), execOnly: stats(catExec) };
    allPrep.push(...catPrep);
    allExec.push(...catExec);
  }
  const overall = { prepExec: stats(allPrep), execOnly: stats(allExec) };
  db.close();

  return {
    label,
    dbPath,
    assetCount,
    sqliteVersion,
    electronAbi: process.versions.modules,
    node: process.versions.node,
    iters,
    warmup,
    limit: DEFAULT_LIMIT,
    bm25: [10, 1, 5, 8, 2, 2],
    categories: catStats,
    overall,
    perQuery,
  };
}

const fmt = (n) => n.toFixed(3).padStart(8);
export function printReport(r) {
  const block = (title, s) =>
    console.log(
      `  ${title.padEnd(10)} p50 ${fmt(s.p50)}  p95 ${fmt(s.p95)}  p99 ${fmt(s.p99)}  ` +
        `mean ${fmt(s.mean)}  min ${fmt(s.min)}  max ${fmt(s.max)}  (ms, n=${s.n})`,
    );
  console.log('='.repeat(96));
  console.log(`FTS5 search latency  —  ${r.label}`);
  console.log(`db=${r.dbPath}`);
  console.log(
    `assets=${r.assetCount.toLocaleString()}  sqlite=${r.sqliteVersion}  electron-abi=${r.electronAbi}  node=${r.node}`,
  );
  console.log(`iters=${r.iters}/query  warmup=${r.warmup}  limit=${r.limit}  bm25=[10,1,5,8,2,2]`);
  console.log('='.repeat(96));
  for (const [cat, s] of Object.entries(r.categories)) {
    console.log(`\n[${cat}]  ${s.queries} queries`);
    block('prep+exec', s.prepExec);
    block('exec-only', s.execOnly);
  }
  console.log(`\n[OVERALL]  ${r.perQuery.length} distinct queries`);
  block('prep+exec', r.overall.prepExec);
  block('exec-only', r.overall.execOnly);
  console.log('='.repeat(96));
}
