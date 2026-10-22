import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { walkRootWithDiagnostics } from '../walker';

/**
 * The scanner used to drop folders silently, which made "nothing there" and
 * "we gave up" indistinguishable in the UI. Every drop must now be reported.
 */

let tmp: string;

function write(root: string, rel: string, bytes = 4): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'x'.repeat(bytes));
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omnidex-diag-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('walkRootWithDiagnostics', () => {
  it('reports an archive-only folder instead of dropping it', async () => {
    const root = mkdtempSync(join(tmp, 'archives-'));
    write(root, 'Sealed/MegaPack.rar');
    write(root, 'Sealed/MegaPack.r00');

    const { diagnostics } = await walkRootWithDiagnostics(root);
    const archive = diagnostics.filter((d) => d.kind === 'archive-only');

    expect(archive).toHaveLength(1);
    expect(archive[0]?.path).toBe(join(root, 'Sealed'));
    // Both the .rar and its .r00 continuation part count as archives.
    expect(archive[0]?.detail).toContain('2 archive(s)');
  });

  it('reports a pack abandoned at the depth limit', async () => {
    // MAX_PACK_SEARCH_DEPTH is 4 and the depth-limit branch probes 2 levels
    // below itself, so content must sit at least 3 levels under depth 4.
    const root = mkdtempSync(join(tmp, 'deep-'));
    write(root, 'A/B/C/D/E/F/G/hero.uasset');

    const { folders, diagnostics } = await walkRootWithDiagnostics(root);
    const abandoned = diagnostics.filter((d) => d.kind === 'depth-limit-abandoned');

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.path).toBe(join(root, 'A', 'B', 'C', 'D'));
    // The old behavior: the folder vanished and the only trace was a
    // depth-1 fallback card with nothing in it.
    expect(folders.some((f) => f.absolutePath === join(root, 'A', 'B', 'C', 'D'))).toBe(false);
  });

  it('reports files that crowd the Windows MAX_PATH limit', async () => {
    const root = mkdtempSync(join(tmp, 'long-'));
    // Pad the pack-relative path out past the 240-char threshold. `root` is
    // already ~40 chars, so 3 × 80-char segments clears it on any host.
    const seg = 'l'.repeat(80);
    write(root, join('LongPack', 'Content', seg, seg, `${seg}.uasset`));

    const { diagnostics } = await walkRootWithDiagnostics(root);
    const long = diagnostics.filter((d) => d.kind === 'path-near-max-length');

    expect(long).toHaveLength(1);
    expect(long[0]?.path.length).toBeGreaterThanOrEqual(240);
    expect(long[0]?.detail).toContain('1 file(s)');
  });

  it('stays silent about a healthy pack', async () => {
    const root = mkdtempSync(join(tmp, 'clean-'));
    write(root, 'GoodPack/Content/hero.uasset');

    const { folders, diagnostics } = await walkRootWithDiagnostics(root);

    expect(folders.map((f) => f.name)).toContain('GoodPack');
    expect(diagnostics).toEqual([]);
  });
});
