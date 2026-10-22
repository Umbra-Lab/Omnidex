#!/usr/bin/env node
/**
 * Self-check for the oracle MCP server. Run:
 *   node scripts/oracle-mcp/server.test.mjs [path-to-omnidex.db]
 * Defaults to the live %APPDATA%/omnidex/omnidex.db (read-only, safe).
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] ?? join(process.env.APPDATA ?? '.', 'omnidex', 'omnidex.db');

const server = spawn(process.execPath, [join(here, 'server.mjs')], {
  env: { ...process.env, ORACLE_DB: dbPath },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let nextId = 1;
const rl = createInterface({ input: server.stdout });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
assert.equal(init.result.serverInfo.name, 'omnidex-oracle');

const list = await rpc('tools/list', {});
// Assert the NAMES, not a count. A bare length check fails on every addition
// while saying nothing about what is missing, and passes if a tool is swapped
// for another.
assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [
  'get_context',
  'list_courses',
  'search_assets',
  'search_lessons',
  'search_transcripts',
]);

const t0 = Date.now();
const search = await rpc('tools/call', {
  name: 'search_transcripts',
  arguments: { query: 'chaos destruction', limit: 5 },
});
const searchMs = Date.now() - t0;
const hitText = search.result.content[0].text;
assert.ok(!search.result.isError, hitText);
assert.ok(hitText.includes('file_id='), `expected hits, got: ${hitText.slice(0, 120)}`);

const [, fileId, startMs] = hitText.match(/file_id=(\d+), start_ms=(\d+)/);
const t1 = Date.now();
const ctx = await rpc('tools/call', {
  name: 'get_context',
  arguments: { file_id: Number(fileId), around_ms: Number(startMs), window_s: 60 },
});
const ctxMs = Date.now() - t1;
assert.ok(ctx.result.content[0].text.includes('@ '), 'expected context cues');

const courses = await rpc('tools/call', { name: 'list_courses', arguments: {} });
const courseLines = courses.result.content[0].text.split('\n');
assert.ok(courseLines.length > 10, `expected many courses, got ${courseLines.length}`);

// Review repros: a raw `null` line must not kill the process...
server.stdin.write('null\n');
const afterNull = await rpc('ping', {});
assert.deepEqual(afterNull.result, {});
// ...a negative limit clamps instead of going unlimited...
const neg = await rpc('tools/call', {
  name: 'search_transcripts',
  arguments: { query: 'the', limit: -1 },
});
assert.ok(neg.result.content[0].text.split('\n').length <= 2, 'limit -1 must clamp to 1');
// ...string ids coerce instead of silently missing (FTS5 columns have no affinity)...
const strCtx = await rpc('tools/call', {
  name: 'get_context',
  arguments: { file_id: String(fileId), around_ms: String(startMs), window_s: 60 },
});
assert.ok(strCtx.result.content[0].text.includes('@ '), 'string ids must coerce');
// ...missing around_ms explains itself, and unknown tools are protocol errors.
const missing = await rpc('tools/call', { name: 'get_context', arguments: { file_id: 1 } });
assert.ok(missing.result.content[0].text.includes('must be numbers'));
const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
assert.equal(unknown.error.code, -32602);

console.log(`OK — ${courseLines.length} courses, search ${searchMs}ms, context ${ctxMs}ms`);
console.log(hitText.split('\n').slice(0, 2).join('\n'));
server.kill();
