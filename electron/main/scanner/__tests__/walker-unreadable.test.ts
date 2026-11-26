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

const { walkRootWithDiagnostics, WALK_DIAGNOSTIC_KINDS, MAX_FILES_PER_PACK } = await import(
  '../walker'
);

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

  it('reports a depth-limit pack whose only .uasset folder failed to list', async () => {
    // D sits at the pack-search depth limit and is a pack only because of
    // D/a/x.uasset. If D/a fails, the diagnostic must cover D itself, or the
    // prune deletes D's row: D is an ancestor of D/a, not under it.
    const root = mkdtempSync(join(tmp, 'lib-'));
    write(root, 'A/B/C/D/a/x.uasset');
    const d = join(root, 'A', 'B', 'C', 'D');
    failing.add(join(d, 'a'));

    const { folders, diagnostics } = await walkRootWithDiagnostics(root);

    const unreadable = diagnostics.filter((x) => x.kind === 'unreadable-folder').map((x) => x.path);
    expect(unreadable).toContain(d);
    // And A must not be invented as a loose-content card because its only
    // pack could not be confirmed this time.
    expect(folders.map((f) => f.name)).not.toContain('A');
  });

  it('does not invent a loose-content card for a category whose children failed', async () => {
    const root = mkdtempSync(join(tmp, 'lib-'));
    write(root, 'Cat/PackX/Content/A.uasset');
    write(root, 'Cat/PackY/Content/B.uasset');
    const cat = join(root, 'Cat');
    failing.add(join(cat, 'PackX'));
    failing.add(join(cat, 'PackY'));

    const { folders, diagnostics } = await walkRootWithDiagnostics(root);

    expect(folders).toEqual([]);
    // Reported itself, so a loose-content row it already had is kept too.
    const unreadable = diagnostics.filter((x) => x.kind === 'unreadable-folder').map((x) => x.path);
    expect(unreadable).toContain(cat);
  });

  it('flags the size partial when a folder skipped by the file cap fails to list', async () => {
    const root = mkdtempSync(join(tmp, 'lib-'));
    const content = join(root, 'Exact', 'Content');
    mkdirSync(join(content, 'Sub'), { recursive: true });
    for (let i = 0; i < MAX_FILES_PER_PACK; i += 1) writeFileSync(join(content, `t${i}.png`), 'x');
    writeFileSync(join(content, 'Sub', 'more.png'), 'x');
    failing.add(join(content, 'Sub'));

    const pack = (await walkRootWithDiagnostics(root)).folders.find((f) => f.name === 'Exact');
    // Every file it could see was counted, but a folder it could not read may
    // hold more: the size is a lower bound.
    expect(pack?.sizeIsPartial).toBe(true);
  }, 120_000);
});
