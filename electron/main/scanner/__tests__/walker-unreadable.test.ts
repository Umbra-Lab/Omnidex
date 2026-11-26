import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A folder that fails to list mid-scan (EACCES, EBUSY, a network share that
 * hiccups) used to vanish from the walk without a word. The prune then read
 * "not seen" as "deleted" and took the pack's favourite flag and enrichment
 * with it. The walk must say which folders it could not read.
 *
 * Tests run as root on CI-like containers, so `chmod 000` does not fail a
 * read. Fail the read deliberately instead.
 */
const { failing } = vi.hoisted(() => ({ failing: new Set<string>() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // Real implementation via `node:fs`, which is not mocked.
  const realReaddir = (await import('node:fs')).promises.readdir;
  const readdir = ((path: string, options?: unknown) => {
    if (failing.has(String(path))) {
      return Promise.reject(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      );
    }
    return (realReaddir as (p: string, o?: unknown) => Promise<unknown>)(path, options);
  }) as typeof actual.readdir;
  return { ...actual, default: { ...actual, readdir }, readdir };
});

const { walkRootWithDiagnostics, WALK_DIAGNOSTIC_KINDS } = await import('../walker');

let tmp: string;

function write(root: string, rel: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'x');
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omnidex-unreadable-'));
});
afterAll(() => {
  failing.clear();
  rmSync(tmp, { recursive: true, force: true });
});

describe('walkRootWithDiagnostics on an unreadable folder', () => {
  it('reports a folder it could not list instead of dropping it silently', async () => {
    const root = mkdtempSync(join(tmp, 'lib-'));
    write(root, 'Fine/Content/A.uasset');
    write(root, 'Category/Locked/Content/B.uasset');
    const locked = join(root, 'Category');
    failing.add(locked);

    const { folders, diagnostics } = await walkRootWithDiagnostics(root);

    expect(folders.map((f) => f.name)).toEqual(['Fine']);
    const unreadable = diagnostics.filter((d) => d.kind === 'unreadable-folder');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.path).toBe(locked);
    expect(unreadable[0]?.detail).toContain('EACCES');
    // Replaced on every scan like the other walk kinds, so a folder that reads
    // fine next time stops being reported.
    expect(WALK_DIAGNOSTIC_KINDS).toContain('unreadable-folder');
  });
});
