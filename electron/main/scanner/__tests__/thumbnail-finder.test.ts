import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findThumbnailSource } from '../thumbnail-finder';

/**
 * `findThumbnailSource` decides what a pack card shows. The `.uasset` branch is
 * the pre-existing behaviour; the image branch is what makes non-UE packs
 * (FBX/OBJ/Blend source) previewable at all — see
 * `docs/LIBRARY-SCALE-FINDINGS-2026-07-27.md` §3.
 */

let tmp: string;

/** Build a temp tree from `relativeDir -> {filename: byteLength}`. `'.'` = root. */
function tree(spec: Record<string, Record<string, number>>): string {
  const root = mkdtempSync(join(tmp, 'pack-'));
  for (const [dir, files] of Object.entries(spec)) {
    const abs = dir === '.' ? root : join(root, dir);
    mkdirSync(abs, { recursive: true });
    for (const [name, size] of Object.entries(files)) {
      writeFileSync(join(abs, name), Buffer.alloc(size, 1));
    }
  }
  return root;
}

const BIG = 200_000;
const MEDIUM = 50_000;
/** Under MIN_IMAGE_BYTES (4096) — treated as a UI icon, not a preview. */
const ICON = 512;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omnidex-thumbfind-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('findThumbnailSource — uasset branch', () => {
  it('returns a uasset result and ignores images alongside it', async () => {
    const root = tree({ '.': { 'SM_Rock.uasset': 10, 'preview.png': BIG } });
    const found = await findThumbnailSource(root);
    expect(found?.kind).toBe('uasset');
    expect(found?.path).toBe(join(root, 'SM_Rock.uasset'));
  });

  it('finds a uasset nested below the root', async () => {
    const root = tree({ 'Content/Meshes': { 'SM_Rock.uasset': 10 } });
    const found = await findThumbnailSource(root);
    expect(found).toEqual({ kind: 'uasset', path: join(root, 'Content/Meshes/SM_Rock.uasset') });
  });

  it('prefers a uasset one level down over an image found deeper', async () => {
    // The BFS visits Textures/ and Meshes/ at the same depth. Whichever comes
    // first, a .uasset anywhere in the walk wins over every collected image.
    const root = tree({
      Textures: { 'preview.png': BIG },
      Meshes: { 'SM_Rock.uasset': 10 },
    });
    const found = await findThumbnailSource(root);
    expect(found?.kind).toBe('uasset');
  });
});

describe('findThumbnailSource — image fallback', () => {
  it('returns the pack preview when there is no uasset (the FBX-pack case)', async () => {
    const root = tree({ '.': { 'preview.jpg': BIG, 'model.fbx': 900 } });
    expect(await findThumbnailSource(root)).toEqual({
      kind: 'image',
      path: join(root, 'preview.jpg'),
    });
  });

  it('accepts every supported extension', async () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'A.PNG']) {
      const root = tree({ '.': { [name]: BIG } });
      expect(await findThumbnailSource(root)).toEqual({ kind: 'image', path: join(root, name) });
    }
  });

  it('picks the largest image at the shallowest depth (hero over thumbnail strip)', async () => {
    const root = tree({ '.': { 'thumb.png': MEDIUM, 'hero.png': BIG, 'tiny.png': MEDIUM / 2 } });
    expect((await findThumbnailSource(root))?.path).toBe(join(root, 'hero.png'));
  });

  it('prefers a shallower image even when a deeper one is larger', async () => {
    const root = tree({
      '.': { 'preview.png': MEDIUM },
      Textures: { 'T_Diffuse_4K.png': BIG },
    });
    expect((await findThumbnailSource(root))?.path).toBe(join(root, 'preview.png'));
  });

  it('skips a root-level icon in favour of a real preview one level down', async () => {
    const root = tree({
      '.': { 'icon.png': ICON },
      Renders: { 'preview.png': BIG },
    });
    expect((await findThumbnailSource(root))?.path).toBe(join(root, 'Renders/preview.png'));
  });

  it('falls back to sub-floor images when every candidate is tiny', async () => {
    const root = tree({ '.': { 'small.png': ICON, 'smaller.png': 64 } });
    expect((await findThumbnailSource(root))?.path).toBe(join(root, 'small.png'));
  });

  it('returns null when the pack has neither uassets nor images', async () => {
    const root = tree({ '.': { 'model.fbx': 900, 'readme.txt': 20 } });
    expect(await findThumbnailSource(root)).toBeNull();
  });

  it('returns null for a nonexistent root', async () => {
    expect(await findThumbnailSource(join(tmp, 'does-not-exist'))).toBeNull();
  });
});

describe('findThumbnailSource — bounds', () => {
  it('does not look for images past MAX_DEPTH either', async () => {
    // depth 5 — one past the limit, same as the uasset cutoff.
    const root = tree({ 'a/b/c/d/e': { 'preview.png': BIG } });
    expect(await findThumbnailSource(root)).toBeNull();
  });

  it('finds an image at exactly MAX_DEPTH', async () => {
    const root = tree({ 'a/b/c/d': { 'preview.png': BIG } });
    expect((await findThumbnailSource(root))?.path).toBe(join(root, 'a/b/c/d/preview.png'));
  });

  it('honours the IGNORE set for images', async () => {
    const root = tree({
      Intermediate: { 'cached.png': BIG },
      '.hidden': { 'dot.png': BIG },
    });
    expect(await findThumbnailSource(root)).toBeNull();
  });
});
