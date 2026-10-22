/**
 * Asset ecosystem classification. Ported from
 * `src-tauri/src/models/ecosystem.rs`.
 *
 * Only the enum + string constants are carried over — extension-matching and
 * detection logic stay in Rust until Phase 2 retires the scanner.
 */
export type AssetEcosystem =
  | 'unreal_engine'
  | 'unity'
  | 'blender'
  | 'zbrush'
  | 'after_effects'
  | 'cinema4d'
  | 'marvelous_designer'
  | 'substance'
  | 'maya'
  | '3ds_max'
  | 'houdini'
  | 'general_3d'
  | 'audio'
  | 'agnostic'
  | 'software'
  | 'unknown';

export const ASSET_ECOSYSTEMS: AssetEcosystem[] = [
  'unreal_engine',
  'unity',
  'blender',
  'zbrush',
  'after_effects',
  'cinema4d',
  'marvelous_designer',
  'substance',
  'maya',
  '3ds_max',
  'houdini',
  'general_3d',
  'audio',
  'agnostic',
  'software',
  'unknown',
];

export function parseEcosystem(raw: string | null | undefined): AssetEcosystem {
  if (!raw) return 'unknown';
  return ASSET_ECOSYSTEMS.includes(raw as AssetEcosystem) ? (raw as AssetEcosystem) : 'unknown';
}
