import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FILES_PER_PACK, walkRoot } from '../walker';

/**
 * Regression coverage for the `file_size` accounting bug. The walker summed
 * `info.size` only while `count <= 200`, so every byte past the 200th file was
 * silently dropped — a typical multi-thousand-file UE pack reported a tiny
 * sliver of its real size on disk. `fileSize` must now reflect *every*
 * enumerated file (up to the per-pack file ceiling), not just the first 200.
 */

let tmp: string;

/**
 * Build a temp tree from a spec of `relativeDir -> { count, bytes }`. Each
 * directory gets `count` files, every file `bytes` bytes long, named with a
 * monotonic index so they're distinct. Returns the temp root.
 */
function tree(spec: Record<string, { count: number; bytes: number }>): string {
  const root = mkdtempSync(join(tmp, 'pack-'));
  for (const [dir, { count, bytes }] of Object.entries(spec)) {
    const abs = join(root, dir);
    mkdirSync(abs, { recursive: true });
    const body = 'x'.repeat(bytes);
    for (let i = 0; i < count; i += 1) {
      writeFileSync(join(abs, `asset_${i}.uasset`), body);
    }
  }
  return root;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omnidex-walker-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('walkRoot file_size accounting', () => {
  it('sums every file past the 200-file mark, not just the first 200', async () => {
    // One pack: <root>/BigPack/Content/<250 files × 10 bytes>. The `Content/`
    // child makes BigPack a detected pack; the 250 files exercise the path
    // beyond the old `count <= 200` size cap.
    const FILE_COUNT = 250;
    const FILE_BYTES = 10;
    const root = tree({ 'BigPack/Content': { count: FILE_COUNT, bytes: FILE_BYTES } });

    const folders = await walkRoot(root);
    const pack = folders.find((f) => f.name === 'BigPack');
    expect(pack).toBeDefined();

    // All 250 files counted...
    expect(pack?.fileCount).toBe(FILE_COUNT);
    // ...and all 250 files' bytes summed, not the 200-file (2000-byte) cap.
    expect(pack?.fileSize).toBe(FILE_COUNT * FILE_BYTES);
    // Guard against silent regression to the old behavior.
    expect(pack?.fileSize).toBeGreaterThan(200 * FILE_BYTES);
    expect(pack?.hasUassetFiles).toBe(true);
    // Well under the per-pack cap, so the figure is exact and must not be
    // rendered with a "+".
    expect(pack?.sizeIsPartial).toBe(false);
  });
});

/**
 * `MAX_FILES_PER_PACK` still cuts the walk short — 29 of the user's 1,256 real
 * packs exceed it, together under-reporting 247.6 GB (see
 * docs/LIBRARY-SCALE-FINDINGS-2026-07-27.md §2). The size is allowed to be a
 * lower bound; it is *not* allowed to be silently wrong. `sizeIsPartial` is
 * what lets the inspector render "26.7 GB+".
 */
describe('walkRoot truncation reporting', () => {
  it('flags sizeIsPartial when a pack exceeds MAX_FILES_PER_PACK', async () => {
    const FILE_COUNT = MAX_FILES_PER_PACK + 1;
    const FILE_BYTES = 1;
    const root = tree({ 'HugePack/Content': { count: FILE_COUNT, bytes: FILE_BYTES } });

    const folders = await walkRoot(root);
    const pack = folders.find((f) => f.name === 'HugePack');
    expect(pack).toBeDefined();

    expect(pack?.sizeIsPartial).toBe(true);
    // The walk stops at the cap, so both figures are lower bounds — never
    // more than the cap, and never zero.
    expect(pack?.fileCount).toBe(MAX_FILES_PER_PACK);
    expect(pack?.fileSize).toBe(MAX_FILES_PER_PACK * FILE_BYTES);
    expect(pack?.fileSize).toBeLessThan(FILE_COUNT * FILE_BYTES);
    expect(pack?.hasUassetFiles).toBe(true);
  }, // Writing 5,001 files is slow on Windows; well past the 5s default.
  120_000);

  it('flags sizeIsPartial when a pack nests past MAX_DEPTH_PER_PACK', async () => {
    // Content/ makes DeepPack a pack; the walk starts at depth 0 there and
    // bails at depth 8, so the file at depth 9 is never counted.
    const deep = 'DeepPack/Content/a/b/c/d/e/f/g/h';
    const root = tree({
      'DeepPack/Content': { count: 1, bytes: 10 },
      [deep]: { count: 1, bytes: 999 },
    });

    const folders = await walkRoot(root);
    const pack = folders.find((f) => f.name === 'DeepPack');
    expect(pack).toBeDefined();
    expect(pack?.sizeIsPartial).toBe(true);
    expect(pack?.fileSize).toBeLessThan(10 + 999);
  });
});
