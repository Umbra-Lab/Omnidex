import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverDccFiles } from '../dcc-discovery';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DCC discovery', () => {
  it('finds native scenes, meshes, materials and archives without indexing textures as models', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omnidex-dcc-'));
    roots.push(root);
    const folder = join(root, 'Characters', 'Humans', 'Female');
    mkdirSync(folder, { recursive: true });
    for (const name of [
      'Full Body.blend',
      'Rig.fbx',
      'Skin.sbsar',
      'Body_BaseColor.png',
      'Pack.zip',
    ]) {
      writeFileSync(join(folder, name), 'x');
    }
    const result = await discoverDccFiles(root);
    expect(result.map((item) => [item.name, item.kind, item.ecosystem])).toEqual([
      ['Full Body.blend', 'scene', 'blender'],
      ['Pack.zip', 'archive', 'agnostic'],
      ['Rig.fbx', 'mesh', 'general_3d'],
      ['Skin.sbsar', 'material', 'substance'],
    ]);
  });

  it('fails on an unreadable root rather than reporting an empty successful scan', async () => {
    await expect(discoverDccFiles(join(tmpdir(), 'missing-omnidex-dcc-root'))).rejects.toThrow();
  });

  it('records texture sets once and retains path words for search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omnidex-dcc-'));
    roots.push(root);
    const folder = join(root, 'Female Human', 'Skin');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Body_BaseColor.png'), 'x');
    writeFileSync(join(folder, 'Body_Normal.png'), 'x');
    const result = await discoverDccFiles(root);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'texture_set', path: folder });
    expect(result[0].relativePath).toContain('Female Human');
    expect(result[0].searchTerms).toContain('Body_BaseColor.png');
  });

  it('stops when cancelled instead of returning partial results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omnidex-dcc-'));
    roots.push(root);
    const controller = new AbortController();
    controller.abort();
    await expect(discoverDccFiles(root, controller.signal)).rejects.toThrow();
  });

  it('indexes a texture library selected directly as the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omnidex-textures-'));
    roots.push(root);
    writeFileSync(join(root, 'rock_roughness.exr'), 'x');
    writeFileSync(join(root, 'rock_normal.exr'), 'x');
    expect(await discoverDccFiles(root)).toMatchObject([{ path: root, kind: 'texture_set' }]);
  });

  it('distinguishes Marvelous Designer projects from ZBrush projects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omnidex-formats-'));
    roots.push(root);
    writeFileSync(join(root, 'clothes.zprj'), 'x');
    writeFileSync(join(root, 'sculpt.zpr'), 'x');
    const result = await discoverDccFiles(root);
    expect(result.map(({ name, ecosystem }) => [name, ecosystem])).toEqual([
      ['clothes.zprj', 'marvelous_designer'],
      ['sculpt.zpr', 'zbrush'],
    ]);
  });
});
