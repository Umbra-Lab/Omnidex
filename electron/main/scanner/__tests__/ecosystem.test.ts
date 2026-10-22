import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetEcosystem } from '@omnidex/types/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectEcosystemSignals, detectEcosystem } from '../ecosystem';

/**
 * Branch coverage for the ecosystem classifier (`detectEcosystem`) and its
 * signal collector (`collectEcosystemSignals`). No existing test references
 * either function — the only `ecosystem` hits in the suite are the DB column,
 * not this scanner-side classifier.
 *
 * `detectEcosystem` is a pure function over an `EcosystemSignals` shape, so the
 * band/precedence branches are asserted directly. `collectEcosystemSignals`
 * walks a real (max-depth-2) tree, so it's exercised through the mkdtemp
 * tree-builder pattern used by the sibling walker/name-resolver suites.
 */

let tmp: string;

/**
 * Build a temp tree from `relativeDir -> [filenames]`. Directories are created
 * recursively; every file gets a 1-byte body. Returns the temp root so callers
 * can hand it straight to `collectEcosystemSignals`.
 */
function tree(spec: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmp, 'eco-'));
  for (const [dir, files] of Object.entries(spec)) {
    const abs = join(root, dir);
    mkdirSync(abs, { recursive: true });
    for (const f of files) writeFileSync(join(abs, f), 'x');
  }
  return root;
}

/** Minimal signal builder so the pure-function cases read declaratively. */
function signals(
  exts: string[],
  opts: { content?: boolean; blender?: boolean; totalFiles?: number } = {},
) {
  return {
    extensions: new Set(exts),
    hasContentSubfolder: opts.content ?? false,
    hasBlenderMarkers: opts.blender ?? false,
    totalFiles: opts.totalFiles ?? (exts.length || (opts.content || opts.blender ? 1 : 0)),
  };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omnidex-ecosystem-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('detectEcosystem — empty / fallback branches', () => {
  it('classifies an empty folder (no files at all) as unknown', () => {
    expect(detectEcosystem(signals([], { totalFiles: 0 }))).toBe('unknown');
  });

  it('still returns unknown when a Content/ dir exists but the tree is fileless', () => {
    // totalFiles === 0 short-circuits BEFORE the hasContentSubfolder check, so
    // an empty `Content/` wrapper must not masquerade as unreal_engine.
    expect(detectEcosystem(signals([], { content: true, totalFiles: 0 }))).toBe('unknown');
  });

  it('classifies a non-empty folder with no recognized ecosystem as agnostic', () => {
    expect(detectEcosystem(signals(['txt', 'pdf', 'json']))).toBe('agnostic');
  });
});

describe('detectEcosystem — software-specific extension sets', () => {
  const cases: Array<[string, string[], AssetEcosystem]> = [
    ['uasset → unreal_engine', ['uasset'], 'unreal_engine'],
    ['umap → unreal_engine', ['umap'], 'unreal_engine'],
    ['blend → blender', ['blend'], 'blender'],
    ['ztl → zbrush', ['ztl'], 'zbrush'],
    ['aep → after_effects', ['aep'], 'after_effects'],
    ['c4d → cinema4d', ['c4d'], 'cinema4d'],
    ['zpac → marvelous_designer', ['zpac'], 'marvelous_designer'],
    ['sbsar → substance', ['sbsar'], 'substance'],
    ['unitypackage → unity', ['unitypackage'], 'unity'],
    ['prefab → unity', ['prefab'], 'unity'],
    ['mb → maya', ['mb'], 'maya'],
    ['max → 3ds_max', ['max'], '3ds_max'],
    ['hip → houdini', ['hip'], 'houdini'],
  ];
  for (const [label, exts, expected] of cases) {
    it(`maps ${label}`, () => {
      expect(detectEcosystem(signals(exts))).toBe(expected);
    });
  }
});

describe('detectEcosystem — generic categories', () => {
  it('maps a general 3D interchange ext (fbx) to general_3d', () => {
    expect(detectEcosystem(signals(['fbx']))).toBe('general_3d');
  });

  it('maps glb to general_3d', () => {
    expect(detectEcosystem(signals(['glb']))).toBe('general_3d');
  });

  it('classifies a majority-audio folder as agnostic (the audio branch)', () => {
    // wav + mp3 + flac (all audio) vs. a single non-audio txt → majority audio.
    expect(detectEcosystem(signals(['wav', 'mp3', 'flac', 'txt']))).toBe('agnostic');
  });

  it('does NOT treat a tied audio/non-audio mix as audio-majority', () => {
    // 2 audio of 4 distinct exts is NOT a strict majority (audio > size/2 is
    // 2 > 2 == false) → falls through to the agnostic catch-all anyway, but via
    // a different branch. Assert the boundary explicitly.
    expect(detectEcosystem(signals(['wav', 'mp3', 'txt', 'json']))).toBe('agnostic');
  });
});

describe('detectEcosystem — precedence / ordering', () => {
  it('prefers unreal_engine over blender when both extension sets match', () => {
    // Order matters: the UE check runs before the blender check.
    expect(detectEcosystem(signals(['uasset', 'blend']))).toBe('unreal_engine');
  });

  it('treats a Content/ subfolder as unreal_engine even with zero UE extensions', () => {
    expect(detectEcosystem(signals(['txt'], { content: true }))).toBe('unreal_engine');
  });

  it('treats blender markers as blender even with no .blend files', () => {
    expect(detectEcosystem(signals(['py'], { blender: true }))).toBe('blender');
  });

  it('prefers a specific ecosystem (zbrush) over the general_3d fallback', () => {
    expect(detectEcosystem(signals(['ztl', 'fbx']))).toBe('zbrush');
  });
});

describe('collectEcosystemSignals — real tree walking', () => {
  it('collects top-level extensions and counts files', async () => {
    const root = tree({ '.': ['Mesh.uasset', 'Mesh.uexp', 'readme.txt'] });
    const sig = await collectEcosystemSignals(root);
    expect(sig.totalFiles).toBe(3);
    expect(sig.extensions.has('uasset')).toBe(true);
    expect(sig.extensions.has('uexp')).toBe(true);
    expect(sig.extensions.has('txt')).toBe(true);
    expect(detectEcosystem(sig)).toBe('unreal_engine');
  });

  it('descends exactly one level deeper and unions nested extensions', async () => {
    // Top-level .obj plus a nested Models/ dir with .blend — both must surface.
    const root = tree({ '.': ['scene.obj'], Models: ['rig.blend'] });
    const sig = await collectEcosystemSignals(root);
    expect(sig.extensions.has('obj')).toBe(true);
    expect(sig.extensions.has('blend')).toBe(true);
    // obj alone would be general_3d, but the nested blend wins by ordering.
    expect(detectEcosystem(sig)).toBe('blender');
  });

  it('does NOT collect extensions three levels deep (depth-2 cap)', async () => {
    // root/A/B/deep.blend lives at depth 2 below root → past the 1-level dive.
    const root = tree({ '.': ['top.obj'], 'A/B': ['deep.blend'] });
    const sig = await collectEcosystemSignals(root);
    expect(sig.extensions.has('obj')).toBe(true);
    expect(sig.extensions.has('blend')).toBe(false);
    // Only the depth-0 obj counts toward totals; deep.blend is invisible.
    expect(sig.totalFiles).toBe(1);
    expect(detectEcosystem(sig)).toBe('general_3d');
  });

  it('flags a Content/ dir discovered one level deep (nested-Content branch)', async () => {
    // No UE extensions anywhere. `Sub/Content` sits one level below the root, so
    // the depth-1 dive into `Sub` discovers the nested `Content/` dir. A loose
    // file at the root keeps totalFiles > 0 so detection doesn't short-circuit.
    const root = tree({ '.': ['notes.txt'], 'Sub/Content': ['placeholder.txt'] });
    const sig = await collectEcosystemSignals(root);
    expect(sig.hasContentSubfolder).toBe(true);
    expect(detectEcosystem(sig)).toBe('unreal_engine');
  });

  it('does NOT flag a Content/ dir buried two levels deep (depth cap)', async () => {
    // `A/B/Content` is depth 2 below the root — past the 1-level dive. The
    // collector never sees it, so an unrelated loose file classifies the folder.
    const root = tree({ '.': ['model.fbx'], 'A/B/Content': ['x.txt'] });
    const sig = await collectEcosystemSignals(root);
    expect(sig.hasContentSubfolder).toBe(false);
    expect(detectEcosystem(sig)).toBe('general_3d');
  });

  it('detects blender markers (blender_manifest.toml / __init__.py)', async () => {
    const root = tree({ '.': ['blender_manifest.toml', '__init__.py', 'tool.py'] });
    const sig = await collectEcosystemSignals(root);
    expect(sig.hasBlenderMarkers).toBe(true);
    expect(detectEcosystem(sig)).toBe('blender');
  });

  it('ignores archive extensions so a zipped pack is not misclassified', async () => {
    // A lone .zip must NOT register as a recognized extension; the folder is
    // non-empty so it lands in the agnostic catch-all, never general_3d/etc.
    const root = tree({ '.': ['pack.zip'] });
    const sig = await collectEcosystemSignals(root);
    expect(sig.totalFiles).toBe(1);
    expect(sig.extensions.has('zip')).toBe(false);
    expect(detectEcosystem(sig)).toBe('agnostic');
  });

  it('returns empty signals (and unknown) for an unreadable / missing root', async () => {
    const sig = await collectEcosystemSignals(join(tmp, 'does-not-exist'));
    expect(sig.totalFiles).toBe(0);
    expect(sig.extensions.size).toBe(0);
    expect(detectEcosystem(sig)).toBe('unknown');
  });
});
