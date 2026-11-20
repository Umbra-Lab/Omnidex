#!/usr/bin/env node
/**
 * Self-check for the Oracle docs tools. Builds a tiny docs mirror with the real Python
 * indexer, then exercises every docs_* tool. Needs python (3.11+) on PATH. Run:
 *   node scripts/oracle-mcp/docs-tools.test.mjs
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callDocsTool, docsTools, parseCitation } from './docs-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const indexer = join(here, '..', 'docs-mirror', 'docs_mirror.py');
const mirror = mkdtempSync(join(tmpdir(), 'oracle-docs-'));
const dbPath = join(mirror, 'docs.db');

try {
  // Before the mirror exists, every tool degrades to a clear message instead of throwing.
  assert.match(callDocsTool('docs_search', { query: 'x' }, dbPath), /Docs mirror not built/);

  const page = (rel, meta, body) => {
    const file = join(mirror, 'docs', rel);
    mkdirSync(dirname(file), { recursive: true });
    const front = Object.entries(meta)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    writeFileSync(file, `---\n${front}\n---\n\n${body}`);
  };
  const common = {
    product: 'blender',
    product_version: '5.3.1',
    doc_version: '5.3',
    doc_set: 'python-api',
    kind: 'reference',
    fetched_at: '2026-11-20T08:00:00+00:00',
  };
  page(
    'blender/5.3/python-api/bpy.ops.mesh.md',
    {
      ...common,
      title: 'bpy.ops.mesh',
      source_url: 'https://docs.blender.org/api/5.3/bpy.ops.mesh.html',
    },
    '# bpy.ops.mesh\n\nMesh operators.\n\n## primitive_cube_add\n\n' +
      'bpy.ops.mesh.primitive_cube_add(size=2.0)\n\nConstruct a **cube** mesh.\n\n' +
      '## Long section\n\n' +
      Array.from({ length: 3000 }, (_, i) => `line ${i} of a long reference table`).join('\n'),
  );
  page(
    'unreal/5.7/unreal-mcp/index.md',
    {
      ...common,
      product: 'unreal',
      product_version: '5.7',
      doc_version: '5.7',
      doc_set: 'unreal-mcp',
      kind: 'guide',
      title: 'Unreal MCP',
      source_url: 'https://dev.epicgames.com/x',
    },
    '# Unreal MCP\n\nUnreal MCP is Experimental.',
  );
  writeFileSync(
    join(mirror, 'versions.json'),
    JSON.stringify({ blender: { version: '5.3.1' }, unreal: { version: '5.8' } }),
  );
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const built = spawnSync(py, [indexer, 'index', '--mirror-dir', mirror], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr || built.stdout);

  assert.deepEqual(docsTools.map((t) => t.name).sort(), [
    'docs_outline',
    'docs_read',
    'docs_search',
    'docs_verify',
    'docs_versions',
  ]);
  assert.deepEqual(parseCitation('a/b.md#sec@5.3'), {
    path: 'a/b.md',
    anchor: 'sec',
    version: '5.3',
  });
  assert.deepEqual(parseCitation('a/b.md'), { path: 'a/b.md', anchor: null, version: null });

  // Search finds an API name whole, ranks the section that defines it, and gives a citation.
  const hits = callDocsTool('docs_search', { query: 'primitive_cube_add' }, dbPath);
  assert.match(hits, /^blender\/5\.3\/python-api\/bpy\.ops\.mesh\.md#primitive_cube_add@5\.3/);
  assert.match(
    callDocsTool('docs_search', { query: 'Experimental', product: 'blender' }, dbPath),
    /No sections matched/,
  );
  // FTS syntax in user input is literal, not an operator.
  assert.doesNotThrow(() => callDocsTool('docs_search', { query: 'NEAR( "x" OR' }, dbPath));

  const outline = callDocsTool(
    'docs_outline',
    { path: 'blender/5.3/python-api/bpy.ops.mesh.md' },
    dbPath,
  );
  assert.match(outline, /#primitive_cube_add/);
  assert.match(outline, /#long-section/);

  // Whole-page read comes in chunks that say how much is left; reading them all returns
  // every character of the page.
  let offset = 0;
  let collected = '';
  let chunks = 0;
  for (;;) {
    const out = callDocsTool(
      'docs_read',
      { path: 'blender/5.3/python-api/bpy.ops.mesh.md', offset },
      dbPath,
    );
    const body = out.split('\n---\n')[1];
    collected += body;
    chunks++;
    const next = out.match(/next_offset: (\d+)/);
    if (!next) {
      assert.match(out, /has_more: false/);
      break;
    }
    assert.match(out, /NOT FINISHED/);
    offset = Number(next[1]);
  }
  assert.ok(chunks >= 4, `expected several chunks, got ${chunks}`);
  assert.ok(collected.includes('line 0 of a long') && collected.includes('line 2999 of a long'));

  const sec = callDocsTool(
    'docs_read',
    { path: 'blender/5.3/python-api/bpy.ops.mesh.md#primitive_cube_add@5.3' },
    dbPath,
  );
  assert.match(
    sec,
    /cite as blender\/5\.3\/python-api\/bpy\.ops\.mesh\.md#primitive_cube_add@5\.3/,
  );
  assert.match(sec, /has_more: false/);

  const cite = 'blender/5.3/python-api/bpy.ops.mesh.md#primitive_cube_add@5.3';
  assert.match(
    callDocsTool('docs_verify', { path: cite, quote: 'Construct a cube   mesh.' }, dbPath),
    /^VERIFIED/,
  );
  assert.match(
    callDocsTool('docs_verify', { path: cite, quote: 'Construct a sphere' }, dbPath),
    /^NOT VERIFIED/,
  );
  assert.match(
    callDocsTool('docs_verify', { path: cite.replace('@5.3', '@5.2'), quote: 'cube' }, dbPath),
    /not 5\.2/,
  );
  assert.match(
    callDocsTool(
      'docs_verify',
      { path: cite.replace('primitive_cube_add', 'long-section'), quote: 'Construct a cube' },
      dbPath,
    ),
    /^PARTLY VERIFIED/,
  );

  // The mirror says when docs are for a different version than the one installed.
  const versions = callDocsTool('docs_versions', {}, dbPath);
  assert.match(versions, /blender: 5\.3\.1\n/);
  assert.match(versions, /unreal: 5\.8 {2}← MISMATCH: docs mirrored for 5\.7/);

  console.log(`OK — docs tools, ${chunks} chunks read back whole`);
} finally {
  rmSync(mirror, { recursive: true, force: true });
}
