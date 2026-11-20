/**
 * A line-by-line reader for Unity's text serialization. It is not a YAML parser: Unity
 * writes a fixed shape (`--- !u!<classID> &<fileID>` documents with two-space top-level
 * fields), and everything Omnidex needs can be read from single lines. Lines are pushed
 * one at a time, so a 200 MB scene never has to sit in memory.
 *
 * It collects:
 * - every GUID the file references (`guid: <32 hex>`, also the JSON form Shader Graph uses);
 * - for scenes and prefabs, an outline: the root objects, how many of each component type
 *   the file holds, and which scripts (by GUID) its MonoBehaviours run;
 * - for prefabs, the parent prefab's GUID when the prefab is a variant.
 */

/** Unity class IDs for the components worth naming; anything else shows as `Class<id>`. */
const CLASS_NAMES: Record<number, string> = {
  1: 'GameObject',
  4: 'Transform',
  20: 'Camera',
  23: 'MeshRenderer',
  33: 'MeshFilter',
  50: 'Rigidbody2D',
  54: 'Rigidbody',
  58: 'CircleCollider2D',
  61: 'BoxCollider2D',
  64: 'MeshCollider',
  65: 'BoxCollider',
  81: 'AudioListener',
  82: 'AudioSource',
  95: 'Animator',
  96: 'TrailRenderer',
  108: 'Light',
  111: 'Animation',
  114: 'MonoBehaviour',
  120: 'LineRenderer',
  135: 'SphereCollider',
  136: 'CapsuleCollider',
  137: 'SkinnedMeshRenderer',
  143: 'CharacterController',
  195: 'NavMeshAgent',
  198: 'ParticleSystem',
  199: 'ParticleSystemRenderer',
  205: 'LODGroup',
  212: 'SpriteRenderer',
  215: 'ReflectionProbe',
  218: 'Terrain',
  220: 'LightProbeGroup',
  222: 'CanvasRenderer',
  223: 'Canvas',
  224: 'RectTransform',
  225: 'CanvasGroup',
  320: 'PlayableDirector',
  331: 'SpriteMask',
  1001: 'PrefabInstance',
  1660057539: 'SceneRoots',
  2083052967: 'VisualEffect',
};

/** Scene-level settings documents, not things a person placed. */
const SCENE_SETTINGS = new Set([29, 104, 157, 196, 1660057539]);

/** Unity's built-in resource GUIDs: referenced everywhere, never a project file. */
const BUILTIN_GUIDS = new Set([
  '0000000000000000e000000000000000',
  '0000000000000000f000000000000000',
  '0000000000000000d000000000000000',
]);

const DOC_HEADER = /^--- !u!(\d+) &(-?\d+)( stripped)?/;
const GUID = /guid\\?"?\s*:\s*\\?"?([0-9a-f]{32})/g;
const TOP_FIELD = /^ {2}(m_[A-Za-z]+): ?(.*)$/;
const FILE_ID = /\{fileID: (-?\d+)/;
const COMPONENT_ITEM = /^ {2}- component: \{fileID: (-?\d+)/;

/** Past this many documents the outline stops growing; references keep being collected. */
const MAX_OUTLINE_DOCS = 250_000;
const MAX_ROOTS = 200;

export interface UnityRootObject {
  name: string;
  /** Present when the root is an instance of a prefab: that prefab's GUID. */
  prefab?: string;
  children: number;
  components: string[];
}

export interface UnityOutline {
  objects: number;
  prefabInstances: number;
  roots: UnityRootObject[];
  rootsTruncated: boolean;
  components: Record<string, number>;
  /** GUIDs of the MonoScripts this file's MonoBehaviours run. */
  scripts: string[];
  /** True when the file was too large to outline completely. */
  partial: boolean;
}

export interface UnityYamlResult {
  serialization: 'text' | 'binary';
  refs: Set<string>;
  variantOf: string | null;
  outline: UnityOutline | null;
}

export interface UnityYamlOptions {
  /** Build a scene/prefab outline (costs memory proportional to object count). */
  outline: boolean;
  /** The file is a .prefab, so a root prefab instance makes it a variant. */
  prefab?: boolean;
  /** The file's own GUID, left out of its references. */
  selfGuid?: string | null;
}

interface Doc {
  classId: number;
  fileId: string;
  stripped: boolean;
  name?: string;
  gameObject?: string;
  father?: string;
  transformParent?: string;
  sourcePrefab?: string;
  script?: string;
  components?: string[];
}

export class UnityYamlReader {
  private readonly refs = new Set<string>();
  private readonly docs = new Map<string, Doc>();
  private current: Doc | null = null;
  private serialization: 'text' | 'binary' | null = null;
  private docCount = 0;
  private section = '';
  private awaitingNameValue = false;
  private readonly outline: boolean;
  private readonly prefab: boolean;
  private readonly selfGuid: string | null;

  constructor(options: UnityYamlOptions) {
    this.outline = options.outline;
    this.prefab = options.prefab ?? false;
    this.selfGuid = options.selfGuid ?? null;
  }

  /** False once the file proved to be binary; callers can stop reading. */
  get wantsMore(): boolean {
    return this.serialization !== 'binary';
  }

  push(line: string): void {
    if (this.serialization === null) {
      const head = line.replace(/^﻿/, '').trimStart();
      if (head === '') return;
      this.serialization = head.startsWith('%YAML') || head.startsWith('{') ? 'text' : 'binary';
      if (this.serialization === 'binary') return;
    }
    if (this.serialization === 'binary') return;

    if (line.includes('guid')) {
      for (const match of line.matchAll(GUID)) {
        const guid = match[1];
        if (guid !== this.selfGuid && !BUILTIN_GUIDS.has(guid) && !/^0+$/.test(guid)) {
          this.refs.add(guid);
        }
      }
    }
    if (!this.outline) return;

    if (line.startsWith('---')) {
      const header = DOC_HEADER.exec(line);
      if (!header) return;
      this.docCount += 1;
      this.section = '';
      this.awaitingNameValue = false;
      if (this.docCount > MAX_OUTLINE_DOCS) {
        this.current = null;
        return;
      }
      this.current = {
        classId: Number(header[1]),
        fileId: header[2],
        stripped: header[3] !== undefined,
      };
      this.docs.set(this.current.fileId, this.current);
      return;
    }
    const doc = this.current;
    if (!doc) return;

    const field = TOP_FIELD.exec(line);
    if (field) {
      const [, key, value] = field;
      this.section = key;
      if (key === 'm_Name' && doc.classId === 1) doc.name = value.trim();
      else if (key === 'm_GameObject') doc.gameObject = FILE_ID.exec(value)?.[1];
      else if (key === 'm_Father') doc.father = FILE_ID.exec(value)?.[1];
      else if (key === 'm_TransformParent') doc.transformParent = FILE_ID.exec(value)?.[1];
      else if (key === 'm_SourcePrefab') doc.sourcePrefab = /guid: ([0-9a-f]{32})/.exec(value)?.[1];
      else if (key === 'm_Script') doc.script = /guid: ([0-9a-f]{32})/.exec(value)?.[1];
      return;
    }
    if (doc.classId === 1 && this.section === 'm_Component') {
      const component = COMPONENT_ITEM.exec(line);
      if (component) {
        doc.components ??= [];
        doc.components.push(component[1]);
      }
      return;
    }
    // A prefab instance's display name is the m_Name override in its modification list:
    //     propertyPath: m_Name
    //     value: Enemy (2)
    if (doc.classId === 1001 && this.section === 'm_Modification') {
      // Since Unity 2018.3 the parent sits one level down, inside m_Modification.
      if (line.startsWith('    m_TransformParent:')) {
        doc.transformParent = FILE_ID.exec(line)?.[1];
        return;
      }
      const trimmed = line.trim();
      if (trimmed === 'propertyPath: m_Name') this.awaitingNameValue = true;
      else if (this.awaitingNameValue && trimmed.startsWith('value:')) {
        doc.name ??= trimmed.slice('value:'.length).trim();
        this.awaitingNameValue = false;
      } else if (trimmed.startsWith('- target:')) this.awaitingNameValue = false;
    }
  }

  finish(): UnityYamlResult {
    const serialization = this.serialization ?? 'binary';
    if (serialization === 'binary') {
      return { serialization, refs: new Set(), variantOf: null, outline: null };
    }
    let variantOf: string | null = null;
    for (const doc of this.prefab ? this.docs.values() : []) {
      if (doc.classId === 1001 && doc.transformParent === '0' && doc.sourcePrefab) {
        variantOf = doc.sourcePrefab;
        break;
      }
    }
    return {
      serialization,
      refs: this.refs,
      variantOf,
      outline: this.outline ? this.buildOutline() : null,
    };
  }

  private buildOutline(): UnityOutline {
    const components: Record<string, number> = {};
    const scripts = new Set<string>();
    const componentsByObject = new Map<string, string[]>();
    let objects = 0;
    let prefabInstances = 0;
    const childCount = new Map<string, number>();

    for (const doc of this.docs.values()) {
      if (doc.stripped || SCENE_SETTINGS.has(doc.classId)) continue;
      if (doc.classId === 1) {
        objects += 1;
        continue;
      }
      if (doc.classId === 1001) {
        prefabInstances += 1;
        if (doc.transformParent && doc.transformParent !== '0') {
          childCount.set(doc.transformParent, (childCount.get(doc.transformParent) ?? 0) + 1);
        }
        continue;
      }
      if (doc.gameObject === undefined) continue;
      const name = CLASS_NAMES[doc.classId] ?? `Class${doc.classId}`;
      if (doc.classId !== 4 && doc.classId !== 224) {
        components[name] = (components[name] ?? 0) + 1;
        const list = componentsByObject.get(doc.gameObject) ?? [];
        list.push(name);
        componentsByObject.set(doc.gameObject, list);
      }
      if (doc.classId === 114 && doc.script) scripts.add(doc.script);
      if ((doc.classId === 4 || doc.classId === 224) && doc.father && doc.father !== '0') {
        childCount.set(doc.father, (childCount.get(doc.father) ?? 0) + 1);
      }
    }

    const roots: UnityRootObject[] = [];
    let rootsTruncated = false;
    for (const doc of this.docs.values()) {
      if (doc.stripped) continue;
      let root: UnityRootObject | null = null;
      if ((doc.classId === 4 || doc.classId === 224) && doc.father === '0' && doc.gameObject) {
        const owner = this.docs.get(doc.gameObject);
        if (!owner || owner.stripped) continue;
        root = {
          name: owner.name ?? '(unnamed)',
          children: childCount.get(doc.fileId) ?? 0,
          components: componentsByObject.get(doc.gameObject) ?? [],
        };
      } else if (doc.classId === 1001 && doc.transformParent === '0') {
        root = {
          name: doc.name ?? '(prefab instance)',
          prefab: doc.sourcePrefab,
          children: 0,
          components: [],
        };
      }
      if (!root) continue;
      if (roots.length >= MAX_ROOTS) {
        rootsTruncated = true;
        break;
      }
      roots.push(root);
    }

    return {
      objects,
      prefabInstances,
      roots,
      rootsTruncated,
      components,
      scripts: [...scripts],
      partial: this.docCount > MAX_OUTLINE_DOCS,
    };
  }
}

/** Read a whole in-memory text (a file inside a .unitypackage). */
export function readUnityYamlText(text: string, options: UnityYamlOptions): UnityYamlResult {
  const reader = new UnityYamlReader(options);
  let start = 0;
  while (start <= text.length && reader.wantsMore) {
    const end = text.indexOf('\n', start);
    const line = end === -1 ? text.slice(start) : text.slice(start, end);
    reader.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (end === -1) break;
    start = end + 1;
  }
  return reader.finish();
}
