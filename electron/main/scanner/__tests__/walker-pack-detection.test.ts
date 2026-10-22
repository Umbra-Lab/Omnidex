import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DetectedAssetFolder } from '../walker';
import { walkRoot } from '../walker';

/**
 * Branch coverage for `findPackFolders` (the pack-discovery phase of the
 * scanner) and its interaction with the ecosystem classifier. The existing
 * `walker.test.ts` only covers the `file_size` accounting fix on a single
 * `Content/`-child pack, so the detection branches below are genuine gaps.
 *
 * `findPackFolders` is module-private; it's driven through the public
 * `walkRoot`, asserting which folders become library rows, their resolved
 * names, and how each is classified. A regression in the branch logic (e.g. a
 * pack's interior `Blueprints/` folder leaking in as its own row, or a loose
 * PDF library being silently dropped) flips a specific assertion red.
 */

let tmp: string;

/**
 * Build a temp tree from `relativeDir -> [filenames]`. Use `'.'` to drop files
 * at the root. Empty arrays create the directory with no files (useful for
 * marker-only layouts like a bare `Content/`). Returns the temp root.
 */
function tree(spec: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmp, 'lib-'));
  for (const [dir, files] of Object.entries(spec)) {
    const abs = join(root, dir);
    mkdirSync(abs, { recursive: true });
    for (const f of files) writeFileSync(join(abs, f), 'x');
  }
  return root;
}

/** Names of detected folders, sorted for stable comparison. */
function names(folders: DetectedAssetFolder[]): string[] {
  return folders.map((f) => f.name).sort();
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omnidex-packdetect-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('findPackFolders — Content/<Category> tree (hasContentDir branch)', () => {
  it('records the depth-1 pack and not its Content/category internals', async () => {
    const root = tree({
      // A loose file sits directly in Content/ (depth-1 of the pack root) so the
      // ecosystem signal collector — which only scans 2 levels — sees a Content/
      // dir AND a non-zero file count. The uassets live deeper, under categories.
      'CityPack/Content': ['Manifest.uproject'],
      'CityPack/Content/Maps': ['M_City.umap'],
      'CityPack/Content/Blueprints': ['BP_Player.uasset'],
    });
    const folders = await walkRoot(root);

    // Exactly one library row: the pack itself.
    expect(names(folders)).toEqual(['CityPack']);
    const pack = folders[0];
    // Content/ presence (plus the .uproject) drives the UE classification.
    expect(pack.ecosystem).toBe('unreal_engine');
    // `hasUassetFiles` reflects the deep stats walk, which reaches the
    // .umap/.uasset nested under Content/<Category>, so it's true.
    expect(pack.hasUassetFiles).toBe(true);
    // The interior Maps/Blueprints folders must NOT surface as their own rows.
    expect(names(folders)).not.toContain('Maps');
    expect(names(folders)).not.toContain('Blueprints');
  });
});

describe('findPackFolders — 2+ bare UE category folders (interiorSignals branch)', () => {
  it('treats a Content-less folder with 2+ interior categories as the pack root', async () => {
    // No Content/ wrapper. Materials + Textures + Meshes are interior signals;
    // 2+ trips MIN_INTERIOR_SIGNALS, so AnimePack is the pack and descent stops.
    const root = tree({
      'AnimePack/Materials': ['M_Skin.uasset'],
      'AnimePack/Textures': ['T_Skin.uasset'],
      'AnimePack/Meshes': ['SM_Body.uasset'],
    });
    const folders = await walkRoot(root);

    expect(names(folders)).toEqual(['AnimePack']);
    // Detection fired via interiorSignals (2+ category dirs), NOT via a direct
    // .uasset at the pack root. But `hasUassetFiles` reflects the full deep
    // stats walk (aggregateDirectoryStats), which DOES reach the uassets nested
    // one level down — so it's true even though findPackFolders' own
    // direct-child `hasUassetHere` check would have been false here.
    expect(folders[0].hasUassetFiles).toBe(true);
    expect(folders[0].ecosystem).toBe('unreal_engine');
    // Category folders are pack internals, never separate rows.
    expect(names(folders)).not.toContain('Materials');
    expect(names(folders)).not.toContain('Meshes');
  });

  it('does NOT trip the interior branch on a single category folder', async () => {
    // Only ONE interior category (Materials) and no Content/ → interiorSignals
    // stays at 1 (< MIN_INTERIOR_SIGNALS). The pack is found instead via the
    // .uasset inside Materials at depth 2.
    const root = tree({ 'SoloPack/Materials': ['M_Only.uasset'] });
    const folders = await walkRoot(root);
    // SoloPack has no direct uasset/Content and only one interior signal, so
    // descent continues to Materials (depth 2) which holds the uasset.
    expect(names(folders)).toEqual(['Materials']);
    expect(folders[0].hasUassetFiles).toBe(true);
  });
});

describe('findPackFolders — direct .uasset at depth (hasUassetHere branch)', () => {
  it('records a nested pack with loose .uasset files under a category container', async () => {
    // root/Category/LoosePack/*.uasset. Category (depth 1) has no marker and
    // descends; LoosePack (depth 2) has direct uassets → recorded there.
    const root = tree({
      'Category/LoosePack': ['A.uasset', 'B.uasset'],
    });
    const folders = await walkRoot(root);

    expect(names(folders)).toEqual(['LoosePack']);
    expect(folders[0].hasUassetFiles).toBe(true);
    expect(folders[0].ecosystem).toBe('unreal_engine');
    // The category container itself is not a row (it found a child pack, so the
    // depth-1 loose-content fallback never fires for it).
    expect(names(folders)).not.toContain('Category');
  });
});

describe('findPackFolders — loose / no-marker folder (depth-1 fallback branch)', () => {
  it('registers a marker-less depth-1 folder so loose libraries are not dropped', async () => {
    // A PDF/tutorial library: no .uasset, no Content/, no interior categories.
    // The depth-1 fallback registers it anyway, classified as agnostic.
    const root = tree({ TutorialsPdf: ['guide.pdf', 'cheatsheet.pdf'] });
    const folders = await walkRoot(root);

    expect(names(folders)).toEqual(['TutorialsPdf']);
    expect(folders[0].hasUassetFiles).toBe(false);
    // Non-empty, no recognized ecosystem → agnostic (so it still passes gates).
    expect(folders[0].ecosystem).toBe('agnostic');
  });

  it('classifies a loose majority-audio library as agnostic via the fallback', async () => {
    const root = tree({ SfxLib: ['a.wav', 'b.wav', 'c.mp3'] });
    const folders = await walkRoot(root);
    expect(names(folders)).toEqual(['SfxLib']);
    expect(folders[0].ecosystem).toBe('agnostic');
  });

  it('does NOT register a deeper marker-less folder (fallback is depth-1 only)', async () => {
    // root/Empty/Nested/ with only a stray .txt — no pack anywhere. The
    // fallback fires for the depth-1 `Empty` folder only; `Nested` is dropped.
    const root = tree({ 'Empty/Nested': ['notes.txt'] });
    const folders = await walkRoot(root);
    expect(names(folders)).toEqual(['Empty']);
    expect(names(folders)).not.toContain('Nested');
  });
});

describe('findPackFolders — multiple sibling packs + ignored dirs', () => {
  it('detects each top-level pack independently and skips ignored/dot dirs', async () => {
    const root = tree({
      'PackA/Content': ['ignored-marker.txt'], // hasContentDir → PackA
      'PackB': ['Mesh.uasset'], // hasUassetHere → PackB
      // Build/ and .git/ are in IGNORED_DIR_NAMES / dotfiles and must vanish,
      // even though Build contains a .uasset.
      'Build': ['stale.uasset'],
      '.git': ['HEAD'],
    });
    const folders = await walkRoot(root);

    expect(names(folders)).toEqual(['PackA', 'PackB']);
    expect(names(folders)).not.toContain('Build');
    expect(names(folders)).not.toContain('.git');

    const a = folders.find((f) => f.name === 'PackA');
    const b = folders.find((f) => f.name === 'PackB');
    expect(a?.ecosystem).toBe('unreal_engine'); // Content/ child
    expect(b?.hasUassetFiles).toBe(true); // direct uasset
    expect(b?.ecosystem).toBe('unreal_engine');
  });

  it('returns no folders for an empty root', async () => {
    const root = tree({});
    const folders = await walkRoot(root);
    expect(folders).toEqual([]);
  });
});
