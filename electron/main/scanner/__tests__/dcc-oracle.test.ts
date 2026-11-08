import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../../db/repos/__tests__/fixtures/test-db';
import { searchAssets } from '../../db/repos/assets';
import { indexDccFiles, scanDccLocation } from '../dcc-index';

describe('Oracle DCC search', () => {
  it('finds indexed file context and reports its type through MCP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnidex-oracle-dcc-'));
    const db = createTestDb();
    db.exec(
      readFileSync(resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'), 'utf8'),
    );
    db.exec(`CREATE TABLE course_files (id INTEGER, asset_id INTEGER, kind TEXT, rel_path TEXT, abs_path TEXT, duration_seconds REAL, chapter TEXT, order_index INTEGER);
      CREATE TABLE transcript_cues (id INTEGER, file_id INTEGER, text TEXT, start_ms INTEGER);
      CREATE VIRTUAL TABLE transcript_fts USING fts5(text, file_id UNINDEXED);`);
    indexDccFiles(db, 2, [
      {
        name: 'Body.blend',
        path: '/dcc/Human/Female/Body.blend',
        relativePath: 'Human/Female/Body.blend',
        kind: 'scene',
        ecosystem: 'blender',
        size: 123,
      },
    ]);
    const path = join(dir, 'oracle.db');
    db.prepare('VACUUM INTO ?').run(path);
    (db as unknown as { close(): void }).close();
    const server = spawn(process.execPath, ['scripts/oracle-mcp/server.mjs'], {
      env: { ...process.env, ORACLE_DB: path },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const lines = createInterface({ input: server.stdout });
      const response = new Promise<string>((resolveResponse, reject) => {
        server.once('error', reject);
        server.once('exit', (code) => reject(new Error(`Oracle exited ${code}`)));
        lines.once('line', resolveResponse);
      });
      server.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_assets', arguments: { query: 'human female blender' } } })}\n`,
      );
      const result = JSON.parse(await response);
      expect(result.result.content[0].text).toContain('Body.blend');
      expect(result.result.content[0].text).toContain('dcc_scene');
    } finally {
      server.kill();
      await new Promise<void>((resolveExit) => server.once('exit', () => resolveExit()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.OMNIDEX_DCC_SAMPLE)(
    'indexes and searches a bounded real folder',
    async () => {
      const root = process.env.OMNIDEX_DCC_SAMPLE as string;
      const dir = mkdtempSync(join(tmpdir(), 'omnidex-real-dcc-'));
      const db = createTestDb();
      db.exec(
        readFileSync(
          resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'),
          'utf8',
        ),
      );
      db.exec(`CREATE TABLE course_files (id INTEGER, asset_id INTEGER, kind TEXT, rel_path TEXT, abs_path TEXT, duration_seconds REAL, chapter TEXT, order_index INTEGER);
      CREATE TABLE transcript_cues (id INTEGER, file_id INTEGER, text TEXT, start_ms INTEGER);
      CREATE VIRTUAL TABLE transcript_fts USING fts5(text, file_id UNINDEXED);`);
      const scan = await scanDccLocation(db, 2, root, new AbortController().signal);
      const hits = searchAssets(db, 'human female blender', 100);
      expect(hits.some((hit) => hit.name.includes('Woman_13'))).toBe(true);
      const path = join(dir, 'oracle.db');
      db.prepare('VACUUM INTO ?').run(path);
      (db as unknown as { close(): void }).close();
      const server = spawn(process.execPath, ['scripts/oracle-mcp/server.mjs'], {
        env: { ...process.env, ORACLE_DB: path },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      try {
        const lines = createInterface({ input: server.stdout });
        const response = new Promise<string>((resolveResponse, reject) => {
          server.once('error', reject);
          server.once('exit', (code) => reject(new Error(`Oracle exited ${code}`)));
          lines.once('line', resolveResponse);
        });
        server.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_assets', arguments: { query: 'human female blender', limit: 100 } } })}\n`,
        );
        const result = JSON.parse(await response);
        expect(result.result.content[0].text).toContain('White_Summer_Woman_13.blend');
        console.log(
          `Real DCC sample: ${scan.total} indexed, ${hits.length} app hits; Oracle found White_Summer_Woman_13.blend`,
        );
      } finally {
        server.kill();
        await new Promise<void>((resolveExit) => server.once('exit', () => resolveExit()));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
