import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const GUID = {
  hull: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  ship: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
  variant: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
  script: 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4',
  scene: 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
  albedo: 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6',
  graph: '0a0b0c0d0e0f0a0b0c0d0e0f0a0b0c0d',
  baked: '1234567890abcdef1234567890abcdef',
};

const YAML_HEAD = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';

export const SHIP_PREFAB = `${YAML_HEAD}--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 400}
  - component: {fileID: 3300}
  - component: {fileID: 2300}
  - component: {fileID: 11400}
  m_Layer: 0
  m_Name: Ship
--- !u!4 &400
Transform:
  m_GameObject: {fileID: 100}
  m_Children: []
  m_Father: {fileID: 0}
--- !u!33 &3300
MeshFilter:
  m_GameObject: {fileID: 100}
  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}
--- !u!23 &2300
MeshRenderer:
  m_GameObject: {fileID: 100}
  m_Materials:
  - {fileID: 2100000, guid: ${GUID.hull}, type: 2}
--- !u!114 &11400
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: ${GUID.script}, type: 3}
  m_Name:
  speed: 12
`;

export const VARIANT_PREFAB = `${YAML_HEAD}--- !u!1001 &9000
PrefabInstance:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 0}
    m_Modifications:
    - target: {fileID: 100, guid: ${GUID.ship}, type: 3}
      propertyPath: m_Name
      value: Ship Variant
      objectReference: {fileID: 0}
    m_RemovedComponents: []
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.ship}, type: 3}
`;

export const MAIN_SCENE = `${YAML_HEAD}--- !u!29 &1
OcclusionCullingSettings:
  m_ObjectHideFlags: 0
--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 11}
  - component: {fileID: 12}
  m_Name: Main Camera
--- !u!4 &11
Transform:
  m_GameObject: {fileID: 10}
  m_Father: {fileID: 0}
--- !u!20 &12
Camera:
  m_GameObject: {fileID: 10}
--- !u!1 &20
GameObject:
  m_Component:
  - component: {fileID: 21}
  m_Name: Lens Flare
--- !u!4 &21
Transform:
  m_GameObject: {fileID: 20}
  m_Father: {fileID: 11}
--- !u!1 &30
GameObject:
  m_Component:
  - component: {fileID: 31}
  - component: {fileID: 32}
  m_Name: Sun
--- !u!4 &31
Transform:
  m_GameObject: {fileID: 30}
  m_Father: {fileID: 0}
--- !u!108 &32
Light:
  m_GameObject: {fileID: 30}
--- !u!1001 &40
PrefabInstance:
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 0}
    m_Modifications:
    - target: {fileID: 400, guid: ${GUID.ship}, type: 3}
      propertyPath: m_LocalPosition.x
      value: 4
      objectReference: {fileID: 0}
    - target: {fileID: 100, guid: ${GUID.ship}, type: 3}
      propertyPath: m_Name
      value: Player Ship
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.ship}, type: 3}
--- !u!1 &41 stripped
GameObject:
  m_CorrespondingSourceObject: {fileID: 100, guid: ${GUID.ship}, type: 3}
  m_PrefabInstance: {fileID: 40}
--- !u!1660057539 &9223372036854775807
SceneRoots:
  m_Roots:
  - {fileID: 11}
  - {fileID: 31}
  - {fileID: 40}
`;

export const HULL_MATERIAL = `${YAML_HEAD}--- !u!21 &2100000
Material:
  m_Name: Hull
  m_Shader: {fileID: -6465566751694194690, guid: ${GUID.graph}, type: 3}
  m_SavedProperties:
    m_TexEnvs:
    - _BaseMap:
        m_Texture: {fileID: 2800000, guid: ${GUID.albedo}, type: 3}
`;

/** Shader Graph files are JSON; older versions escape the nested JSON. */
export const SHADER_GRAPH = `{
    "m_SGVersion": 3,
    "m_Type": "UnityEditor.ShaderGraph.GraphData",
    "m_SerializedSubGraph": "{\\"subgraph\\":{\\"fileID\\":0,\\"guid\\":\\"${GUID.albedo}\\"}}"
}`;

function meta(guid: string): string {
  return `fileFormatVersion: 2\nguid: ${guid}\nNativeFormatImporter:\n  mainObjectFileID: 0\n`;
}

/** Write a small Unity 6 URP project under `root`, plus junk Unity regenerates. */
export function writeSampleProject(root: string): void {
  const files: Record<string, string> = {
    'ProjectSettings/ProjectVersion.txt':
      'm_EditorVersion: 6000.3.0f1\nm_EditorVersionWithRevision: 6000.3.0f1 (abc)\n',
    'Packages/manifest.json': JSON.stringify({
      dependencies: {
        'com.unity.render-pipelines.universal': '17.3.0',
        'com.unity.inputsystem': '1.14.0',
        'com.unity.visualeffectgraph': '17.3.0',
      },
    }),
    'Packages/packages-lock.json': '{}',
    'Packages/com.galaxy.tools/package.json': '{"name":"com.galaxy.tools"}',
    'Packages/com.galaxy.tools/Runtime/Tool.cs': 'class Tool {}',
    'Packages/com.galaxy.tools/Runtime/Tool.cs.meta': meta('9999999999999999aaaaaaaaaaaaaaaa'),
    'Assets/Materials/Hull.mat': HULL_MATERIAL,
    'Assets/Materials/Hull.mat.meta': meta(GUID.hull),
    'Assets/Prefabs/Ship.prefab': SHIP_PREFAB,
    'Assets/Prefabs/Ship.prefab.meta': meta(GUID.ship),
    'Assets/Prefabs/Ship Variant.prefab': VARIANT_PREFAB,
    'Assets/Prefabs/Ship Variant.prefab.meta': meta(GUID.variant),
    'Assets/Scripts/ShipController.cs':
      'public class ShipController : UnityEngine.MonoBehaviour {}\n',
    'Assets/Scripts/ShipController.cs.meta': meta(GUID.script),
    'Assets/Scenes/Main.unity': MAIN_SCENE,
    'Assets/Scenes/Main.unity.meta': meta(GUID.scene),
    'Assets/Shaders/Hull.shadergraph': SHADER_GRAPH,
    'Assets/Shaders/Hull.shadergraph.meta': meta(GUID.graph),
    'Assets/Textures/Hull_Albedo.png': 'not really a png',
    'Assets/Textures/Hull_Albedo.png.meta': meta(GUID.albedo),
    'Assets/Data/Baked.asset': '\u0000\u0001binary-serialized',
    'Assets/Data/Baked.asset.meta': meta(GUID.baked),
    // Unity ignores these; so must Omnidex.
    'Assets/Docs~/Ignored.prefab': SHIP_PREFAB,
    'Assets/.hidden/Ignored.mat': HULL_MATERIAL,
    'Library/ArtifactDB': 'cache',
    'Library/PackageCache/x/Ignored.prefab': SHIP_PREFAB,
    'Temp/Ignored.unity': MAIN_SCENE,
  };
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

function tarHeader(name: string, size: number, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

export function tar(
  entries: Array<{ name: string; body: Buffer | string; type?: string }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === 'string' ? Buffer.from(entry.body) : entry.body;
    parts.push(tarHeader(entry.name, body.length, entry.type));
    parts.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A .unitypackage holding a folder, a prefab (with preview), its material and a texture. */
export function samplePackage(): Buffer {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  return gzipSync(
    tar([
      { name: `./${GUID.ship}/asset`, body: SHIP_PREFAB },
      { name: `./${GUID.ship}/asset.meta`, body: meta(GUID.ship) },
      {
        name: `./${GUID.ship}/pathname`,
        body: 'Assets/PolygonFleet/Prefabs/SM_Ship_01.prefab\n00',
      },
      { name: `./${GUID.ship}/preview.png`, body: png },
      { name: `./${GUID.hull}/pathname`, body: 'Assets/PolygonFleet/Materials/Hull.mat' },
      { name: `./${GUID.hull}/asset`, body: HULL_MATERIAL },
      { name: `./${GUID.albedo}/pathname`, body: 'Assets/PolygonFleet/Textures/Hull.png' },
      { name: `./${GUID.albedo}/asset`, body: Buffer.alloc(2000, 7) },
      { name: `./${GUID.scene}/pathname`, body: 'Assets/PolygonFleet' },
      { name: `./${GUID.scene}/asset.meta`, body: 'folderAsset: yes' },
    ]),
  );
}

/** The JSON the Asset Store writes into a download's gzip header (shape of a real one). */
export const STORE_HEADER = {
  link: { id: '102321', type: 'content' },
  unity_version: '2022.3.62f2',
  pubdate: '07 Oct 2026',
  version: '1.4.0',
  upload_id: '1014102',
  version_id: '1507792',
  category: { id: '4', label: '3D/Vehicles/Sea' },
  id: '102321',
  title: 'POLYGON - Fleet',
  publisher: { id: '5217', label: 'Synty Studios' },
};

/**
 * Give a gzip file the optional "extra" field (FLG.FEXTRA) the Asset Store adds, holding
 * `json` in one subfield. gzipSync writes no other optional header fields, so the field
 * goes straight after the fixed 10-byte header.
 */
export function withStoreHeader(gz: Buffer, json: unknown = STORE_HEADER): Buffer {
  const payload = Buffer.from(JSON.stringify(json));
  const sub = Buffer.alloc(4);
  sub.write('A$', 0, 'latin1');
  sub.writeUInt16LE(payload.length, 2);
  const xlen = Buffer.alloc(2);
  xlen.writeUInt16LE(4 + payload.length, 0);
  const head = Buffer.from(gz.subarray(0, 10));
  head[3] |= 0x04;
  return Buffer.concat([head, xlen, sub, payload, gz.subarray(10)]);
}
