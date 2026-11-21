import { describe, expect, it } from 'vitest';
import { unityKindOf } from '../kinds';
import { readUnityYamlText } from '../yaml';
import { GUID, MAIN_SCENE, SHADER_GRAPH, SHIP_PREFAB, VARIANT_PREFAB } from './fixtures';

describe('Unity YAML reader', () => {
  it('collects references, skipping its own and built-in GUIDs', () => {
    const result = readUnityYamlText(SHIP_PREFAB, { outline: false, selfGuid: GUID.ship });
    expect(result.serialization).toBe('text');
    expect([...result.refs].sort()).toEqual([GUID.hull, GUID.script].sort());
    expect(result.variantOf).toBeNull();
    expect(result.outline).toBeNull();
  });

  it('outlines a prefab: its root, components and scripts', () => {
    const { outline } = readUnityYamlText(SHIP_PREFAB, { outline: true });
    expect(outline?.objects).toBe(1);
    expect(outline?.roots).toEqual([
      { name: 'Ship', children: 0, components: ['MeshFilter', 'MeshRenderer', 'MonoBehaviour'] },
    ]);
    expect(outline?.components).toEqual({ MeshFilter: 1, MeshRenderer: 1, MonoBehaviour: 1 });
    expect(outline?.scripts).toEqual([GUID.script]);
  });

  it('recognises a prefab variant and its parent', () => {
    const result = readUnityYamlText(VARIANT_PREFAB, { outline: true, prefab: true });
    expect(result.variantOf).toBe(GUID.ship);
    expect(result.outline?.roots).toEqual([
      { name: 'Ship Variant', prefab: GUID.ship, children: 0, components: [] },
    ]);
  });

  it('outlines a scene: roots, nested children, prefab instances, no settings documents', () => {
    const result = readUnityYamlText(MAIN_SCENE, { outline: true });
    expect(result.variantOf).toBeNull();
    expect(result.outline?.objects).toBe(3);
    expect(result.outline?.prefabInstances).toBe(1);
    expect(result.outline?.roots).toEqual([
      { name: 'Main Camera', children: 1, components: ['Camera'] },
      { name: 'Sun', children: 0, components: ['Light'] },
      { name: 'Player Ship', prefab: GUID.ship, children: 0, components: [] },
    ]);
    expect(result.outline?.components).toEqual({ Camera: 1, Light: 1 });
  });

  it('reads GUIDs out of Shader Graph JSON, escaped or not', () => {
    const result = readUnityYamlText(SHADER_GRAPH, { outline: false });
    expect(result.serialization).toBe('text');
    expect([...result.refs]).toEqual([GUID.albedo]);
  });

  it('gives up on binary serialization', () => {
    const result = readUnityYamlText('\u0000\u0001\u0002 guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
      outline: true,
    });
    expect(result).toEqual({
      serialization: 'binary',
      refs: new Set(),
      variantOf: null,
      outline: null,
    });
  });

  it('handles CRLF line endings', () => {
    const result = readUnityYamlText(SHIP_PREFAB.replaceAll('\n', '\r\n'), { outline: true });
    expect(result.outline?.roots[0].name).toBe('Ship');
  });

  it('maps extensions to kinds', () => {
    expect(unityKindOf('A/B.unity')).toBe('scene');
    expect(unityKindOf('A/B.shadergraph')).toBe('shader_graph');
    expect(unityKindOf('A/B.vfx')).toBe('vfx_graph');
    expect(unityKindOf('A/B.overrideController')).toBe('animator_controller');
    expect(unityKindOf('A/B.FBX')).toBe('model');
    expect(unityKindOf('A/B.weird')).toBe('other');
  });
});
