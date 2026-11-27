#!/usr/bin/env node
/**
 * Score Oracle search against a list of real queries with known answers, old behaviour
 * against new. Run:
 *
 *   node scripts/oracle-mcp/golden.mjs [golden.json] [path-to-omnidex.db]
 *
 * golden.json defaults to oracle-golden.json next to the library DB (the queries name
 * your own packs and courses, so they live with your data, not in the repo). Copy
 * golden.example.json there to start. Each entry:
 *
 *   { "tool": "search_assets", "query": "scifi corridor", "expect": "ModularSciFiCorridor" }
 *
 * `expect` is a case-insensitive substring that one of the top 5 results must contain
 * (a pack name, a lesson path, a phrase from a cue). `args` adds tool arguments, such as
 * { "course": "Niagara" }. Works for every Oracle search tool.
 *
 * Starts the server twice, read-only: once with ORACLE_SEARCH_LEGACY=1 (exact words, all
 * required) and once as shipped, then prints hit@5 for each.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const TOP = 5;
const here = dirname(fileURLToPath(import.meta.url));
const dbPath =
  process.argv[3] ??
  process.env.ORACLE_DB ??
  join(process.env.APPDATA ?? '.', 'omnidex', 'omnidex.db');
const goldenPath = process.argv[2] ?? join(dirname(dbPath), 'oracle-golden.json');

let golden;
try {
  golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${goldenPath}: ${err.message}`);
  console.error(`Start from ${join(here, 'golden.example.json')}.`);
  process.exit(2);
}

function startServer(legacy) {
  const server = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: { ...process.env, ORACLE_DB: dbPath, ORACLE_SEARCH_LEGACY: legacy ? '1' : '0' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: server.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  return {
    call(name, args) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, (m) => resolve(m.result?.content?.[0]?.text ?? m.error?.message ?? ''));
        server.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`,
        );
      });
    },
    stop: () => server.kill(),
  };
}

/** Split tool output into results: a result starts at a line with no indent. */
function results(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('Note: ') || line.trim() === '') continue;
    if (/^\s/.test(line) && out.length > 0) out[out.length - 1] += `\n${line}`;
    else out.push(line);
  }
  // "No owned assets matched." and friends are one line with no result in it.
  return out.length === 1 && /^(No |Empty query)/.test(out[0]) ? [] : out;
}

async function score(legacy) {
  const server = startServer(legacy);
  const hits = [];
  try {
    for (const g of golden) {
      const text = await server.call(g.tool, { query: g.query, ...(g.args ?? {}) });
      const want = String(g.expect).toLowerCase();
      const rank = results(text)
        .slice(0, TOP)
        .findIndex((r) => r.toLowerCase().includes(want));
      hits.push(rank);
    }
  } finally {
    server.stop();
  }
  return hits;
}

const before = await score(true);
const after = await score(false);

const show = (rank) => (rank < 0 ? '  -' : `  ${rank + 1}`);
console.log('before after  tool                query → expect');
golden.forEach((g, i) => {
  console.log(
    `${show(before[i]).padStart(6)} ${show(after[i]).padStart(5)}  ${g.tool.padEnd(19)} ${g.query} → ${g.expect}`,
  );
});
console.log('');
const tools = [...new Set(golden.map((g) => g.tool))];
for (const tool of [...tools, null]) {
  const idx = golden
    .map((g, i) => (tool === null || g.tool === tool ? i : -1))
    .filter((i) => i >= 0);
  const rate = (hits) => idx.filter((i) => hits[i] >= 0).length;
  console.log(
    `${(tool ?? 'all').padEnd(19)} hit@${TOP}: ${rate(before)}/${idx.length} before, ${rate(after)}/${idx.length} after`,
  );
}
