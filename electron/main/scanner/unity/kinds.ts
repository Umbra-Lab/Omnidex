import { extname } from 'node:path';

/**
 * What a file inside a Unity project or package is, from its extension. `.asset` is
 * any ScriptableObject-style asset; `.prefab` becomes `prefab_variant` later when its
 * YAML says so.
 */
export type UnityAssetKind =
  | 'scene'
  | 'prefab'
  | 'prefab_variant'
  | 'material'
  | 'shader'
  | 'shader_graph'
  | 'vfx_graph'
  | 'animation_clip'
  | 'animator_controller'
  | 'avatar_mask'
  | 'timeline'
  | 'scriptable_object'
  | 'script'
  | 'assembly_definition'
  | 'texture'
  | 'model'
  | 'audio'
  | 'audio_mixer'
  | 'video'
  | 'font'
  | 'physics_material'
  | 'render_texture'
  | 'terrain_layer'
  | 'sprite_atlas'
  | 'lighting_settings'
  | 'ui_toolkit'
  | 'input_actions'
  | 'text'
  | 'other';

const BY_EXTENSION: Record<string, UnityAssetKind> = {
  '.unity': 'scene',
  '.prefab': 'prefab',
  '.mat': 'material',
  '.shader': 'shader',
  '.hlsl': 'shader',
  '.cginc': 'shader',
  '.compute': 'shader',
  '.shadergraph': 'shader_graph',
  '.shadersubgraph': 'shader_graph',
  '.vfx': 'vfx_graph',
  '.vfxoperator': 'vfx_graph',
  '.vfxblock': 'vfx_graph',
  '.anim': 'animation_clip',
  '.controller': 'animator_controller',
  '.overridecontroller': 'animator_controller',
  '.mask': 'avatar_mask',
  '.playable': 'timeline',
  '.asset': 'scriptable_object',
  '.cs': 'script',
  '.asmdef': 'assembly_definition',
  '.asmref': 'assembly_definition',
  '.png': 'texture',
  '.jpg': 'texture',
  '.jpeg': 'texture',
  '.tga': 'texture',
  '.psd': 'texture',
  '.tif': 'texture',
  '.tiff': 'texture',
  '.exr': 'texture',
  '.hdr': 'texture',
  '.bmp': 'texture',
  '.fbx': 'model',
  '.obj': 'model',
  '.blend': 'model',
  '.gltf': 'model',
  '.glb': 'model',
  '.dae': 'model',
  '.3ds': 'model',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.aif': 'audio',
  '.aiff': 'audio',
  '.flac': 'audio',
  '.mixer': 'audio_mixer',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.ttf': 'font',
  '.otf': 'font',
  '.physicmaterial': 'physics_material',
  '.physicsmaterial': 'physics_material',
  '.physicsmaterial2d': 'physics_material',
  '.rendertexture': 'render_texture',
  '.terrainlayer': 'terrain_layer',
  '.spriteatlas': 'sprite_atlas',
  '.spriteatlasv2': 'sprite_atlas',
  '.lighting': 'lighting_settings',
  '.uxml': 'ui_toolkit',
  '.uss': 'ui_toolkit',
  '.tss': 'ui_toolkit',
  '.inputactions': 'input_actions',
  '.json': 'text',
  '.txt': 'text',
  '.md': 'text',
  '.xml': 'text',
  '.bytes': 'text',
};

/** Kinds whose files can carry GUID references to other assets, so they are worth reading. */
const REFERENCING = new Set<UnityAssetKind>([
  'scene',
  'prefab',
  'material',
  'shader_graph',
  'vfx_graph',
  'animation_clip',
  'animator_controller',
  'avatar_mask',
  'timeline',
  'scriptable_object',
  'audio_mixer',
  'physics_material',
  'render_texture',
  'terrain_layer',
  'sprite_atlas',
  'lighting_settings',
  'input_actions',
]);

export function unityKindOf(path: string): UnityAssetKind {
  const extension = extname(path).toLowerCase();
  return Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension] : 'other';
}

export function isReferencingKind(kind: UnityAssetKind): boolean {
  return REFERENCING.has(kind);
}

/** Scenes and prefabs get an outline (root objects, components, scripts) on top of refs. */
export function wantsOutline(kind: UnityAssetKind): boolean {
  return kind === 'scene' || kind === 'prefab';
}
