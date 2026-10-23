import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDeepestPath } from '../name-resolver';

/**
 * Regression coverage for the pack-name resolver. The motivating bug: a real
 * marketplace pack laid out as `<Pack>/Content/{Maps,Blueprints,…}` resolved to
 * the name "Content" because descent stopped at the branching category folder
 * and returned that directory's basename. The resolver must instead fall back
 * to the deepest *meaningful* (non-generic) directory.
 */

let tmp: string;

function tree(spec: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmp, 'pack-'));
  for (const [dir, files] of Object.entries(spec)) {
    const abs = join(root, dir);
    mkdirSync(abs, { recursive: true });
    for (const f of files) writeFileSync(join(abs, f), 'x');
  }
  return root;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omnidex-resolver-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveDeepestPath', () => {
  it('keeps the pack name when Content branches into category folders', async () => {
    // <root>/Content/{Maps,Blueprints,Meshes}/*.uasset
    const root = tree({
      'Content/Maps': ['M_City.umap'],
      'Content/Blueprints': ['BP_Player.uasset'],
      'Content/Meshes': ['SM_Wall.uasset'],
    });
    const resolved = await resolveDeepestPath(root);
    expect(basename(resolved)).toBe(basename(root));
  });

  it('keeps the pack name for a single Content wrapper with one category', async () => {
    const root = tree({ 'Content/Meshes': ['SM_Rock.uasset'] });
    const resolved = await resolveDeepestPath(root);
    // "Meshes" is generic too, so we never adopt it — the pack name wins.
    expect(basename(resolved)).toBe(basename(root));
  });

  it('descends through a generic wrapper to a meaningful inner rename', async () => {
    // <root>/Content/Stylized Castle Pack/<files>
    const root = tree({ 'Content/Stylized Castle Pack': ['SM_Tower.uasset'] });
    const resolved = await resolveDeepestPath(root);
    expect(basename(resolved)).toBe('Stylized Castle Pack');
  });

  it('keeps the readable outer name when the inner folder only drops its spaces', async () => {
    // Epic launcher layout: <Paragon Kwang>/Content/ParagonKwang/<files>
    const root = tree({ 'Paragon Kwang/Content/ParagonKwang/Characters': ['SK_Kwang.uasset'] });
    const resolved = await resolveDeepestPath(join(root, 'Paragon Kwang'));
    expect(basename(resolved)).toBe('Paragon Kwang');
  });

  it('never returns a bare generic container name', async () => {
    const root = tree({
      'Content/Materials': ['M_A.uasset'],
      'Content/Textures': ['T_A.uasset'],
    });
    const resolved = await resolveDeepestPath(root);
    expect(basename(resolved).toLowerCase()).not.toBe('content');
  });
});
