#!/usr/bin/env node
/**
 * Self-contained check for the oracle server's search tools and protocol edges. Builds a
 * throwaway library DB with node:sqlite (no real library needed) and drives server.mjs
 * over stdio. Run:
 *   node scripts/oracle-mcp/server-search.test.mjs
 * CI runs only vitest, so this (like the other oracle *.test.mjs scripts) is run by hand.
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'oracle-search-'));
const dbPath = join(dir, 'omnidex.db');

const db = new DatabaseSync(dbPath);
db.exec(`
PRAGMA journal_mode=wal;
CREATE TABLE assets(id INTEGER PRIMARY KEY, name, display_title, orbital_title, file_path, file_size,
  asset_type, orbital_categories, orbital_seller_name, asset_ecosystem, ecosystem, content_format,
  missing_since, description, tags, orbital_description, scan_search_text);
CREATE TABLE course_files(id INTEGER PRIMARY KEY, asset_id, rel_path, abs_path, kind,
  duration_seconds, chapter, order_index);
CREATE TABLE transcript_cues(id INTEGER PRIMARY KEY, file_id, start_ms, text);
CREATE VIRTUAL TABLE transcript_fts USING fts5(text, content='transcript_cues', content_rowid='id');
CREATE VIRTUAL TABLE assets_fts USING fts5(name, description, tags, orbital_title,
  orbital_description, orbital_seller_name, scan_search_text, content='assets', content_rowid='id');
INSERT INTO assets(id,name,file_path,asset_type) VALUES
  (1,'Course A','/a','course'),(2,'Rock Pack','/r','pack'),(3,'Rock Two','/r2','pack');
`);
const ins = db.prepare(
  "INSERT INTO course_files(asset_id,rel_path,abs_path,kind,chapter,order_index) VALUES (1,?,?,'video',?,?)",
);
for (let i = 0; i < 2500; i++) ins.run(`ch/lesson ${i}.mp4`, `/a/l${i}.mp4`, 1, i);
ins.run('zzz/Ünïcode Ribbon lesson.mp4', '/a/u.mp4', 9, 9999);
ins.run('zzz/50% off_sale.mp4', '/a/p.mp4', 9, 10000);
db.exec("INSERT INTO assets_fts(assets_fts) VALUES('rebuild')");
db.close();

const server = spawn(process.execPath, [join(here, 'server.mjs')], {
  env: { ...process.env, ORACLE_DB: dbPath, ORACLE_DOCS_DB: join(dir, 'none.db') },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
function send(raw, key) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${key}`)), 10_000);
    pending.set(key, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    server.stdin.write(`${raw}\n`);
  });
}
async function tool(name, args) {
  const id = nextId++;
  const m = await send(
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    id,
  );
  return { text: m.result.content[0].text, isError: !!m.result.isError };
}
const lines = (t) => t.split('\n').filter(Boolean);

try {
  // 1. Every term is applied in SQL: a match past the old 2000-row pre-filter is found.
  let r = await tool('search_lessons', { query: 'lesson 2499' });
  assert.match(r.text, /lesson 2499\.mp4/, 'term-2 match beyond row 2000');
  r = await tool('search_lessons', { query: 'ribbon zzz' });
  assert.match(r.text, /Ribbon/);
  // LIKE wildcards in user terms are literal.
  r = await tool('search_lessons', { query: '%' });
  assert.equal(lines(r.text).length, 1);
  assert.match(r.text, /50% off/);
  r = await tool('search_lessons', { query: '_' });
  assert.match(r.text, /off_sale/);
  assert.equal(lines(r.text).length, 1);

  // 2. Non-ASCII case-insensitivity both directions.
  r = await tool('search_lessons', { query: 'ÜNÏCODE' });
  assert.match(r.text, /Ünïcode/);
  r = await tool('search_lessons', { query: 'lesson ünïcode' });
  assert.match(r.text, /Ünïcode/);

  // 3. limit validation across tools.
  r = await tool('search_lessons', { query: 'lesson', limit: -1 });
  assert.equal(lines(r.text).length, 1, 'negative limit clamps to 1');
  r = await tool('search_lessons', { query: 'lesson', limit: 0 });
  assert.equal(lines(r.text).length, 1, 'zero limit clamps to 1');
  r = await tool('search_lessons', { query: 'lesson', limit: 'abc' });
  assert.equal(r.isError, false);
  assert.equal(lines(r.text).length, 30, 'non-numeric limit falls back to default');
  r = await tool('search_lessons', { query: 'lesson', limit: 2.5 });
  assert.equal(lines(r.text).length, 2, 'fractional limit truncates');
  r = await tool('search_lessons', { query: 'lesson', limit: 100000 });
  assert.equal(lines(r.text).length, 200, 'capped at 200');
  r = await tool('search_assets', { query: 'rock', limit: -1 });
  assert.equal(lines(r.text).length, 2, 'one hit = name line + path line');
  r = await tool('search_assets', { query: 'rock', limit: 'abc' });
  assert.equal(r.isError, false);
  assert.equal(lines(r.text).length, 4, 'both assets under default limit');

  // 4. Malformed JSON gets a JSON-RPC parse error, and the server keeps serving.
  const parse = await send('{bad json', null);
  assert.equal(parse.id, null);
  assert.equal(parse.error.code, -32700);
  const pong = await send(JSON.stringify({ jsonrpc: '2.0', id: 'p', method: 'ping' }), 'p');
  assert.deepEqual(pong.result, {});

  console.log('oracle server-search: all checks passed');
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
