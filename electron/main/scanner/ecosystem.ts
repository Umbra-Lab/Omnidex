import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetEcosystem } from '@omnidex/types/db';

/**
 * TypeScript port of `src-tauri/src/models/ecosystem.rs::detect_all_ecosystems`.
 *
 * Scans immediate children and one level deeper (max depth 2) collecting file
 * extensions, then matches against curated per-ecosystem extension sets. Order
 * is intentional — more specific ecosystems win over generic ones.
 */

// Software-specific extensions (high confidence)
const UE_EXTS = new Set(['uasset', 'umap', 'uexp', 'ubulk', 'upk', 'uplugin', 'uproject']);
const BLENDER_EXTS = new Set(['blend', 'blend1']);
const ZBRUSH_EXTS = new Set(['zpr', 'zprj', 'ztl', 'zbr', 'zbp']);
const AFTER_EFFECTS_EXTS = new Set(['aex', 'ffx', 'aep', 'aet']);
const CINEMA4D_EXTS = new Set(['c4d', 'lib4d']);
const MARVELOUS_EXTS = new Set(['zpac', 'dci']);
const SUBSTANCE_EXTS = new Set(['sbs', 'sbsar', 'spp', 'sppr']);
const UNITY_EXTS = new Set(['unitypackage', 'unity', 'prefab']);
const MAYA_EXTS = new Set(['ma', 'mb']);
const MAX3DS_EXTS = new Set(['max', '3ds']);
const HOUDINI_EXTS = new Set(['hip', 'hipnc', 'hda', 'otl']);

// Generic fallback categories
const GENERAL_3D_EXTS = new Set(['fbx', 'obj', 'gltf', 'glb']);
const AUDIO_EXTS = new Set(['wav', 'mp3', 'ogg', 'flac', 'aif', 'aiff', 'wma', 'm4a', 'opus']);

// Ignored during detection so a zipped-up pack doesn't read as a single-file unknown
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz', 'lz4']);

interface EcosystemSignals {
  extensions: Set<string>;
  hasContentSubfolder: boolean;
  hasBlenderMarkers: boolean;
  totalFiles: number;
}

/**
 * Collects ecosystem signals from a folder up to 2 levels deep.
 * Ecosystem detection is intentionally shallow — deep dives don't improve
 * classification quality and slow down scans.
 */
export async function collectEcosystemSignals(root: string): Promise<EcosystemSignals> {
  const extensions = new Set<string>();
  let hasContentSubfolder = false;
  let hasBlenderInit = false;
  let hasBlenderManifest = false;
  let totalFiles = 0;

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { extensions, hasContentSubfolder: false, hasBlenderMarkers: false, totalFiles: 0 };
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      totalFiles += 1;
      if (entry.name === 'blender_manifest.toml') hasBlenderManifest = true;
      if (entry.name === '__init__.py') hasBlenderInit = true;
      const ext = extensionOf(entry.name);
      if (ext && !ARCHIVE_EXTS.has(ext)) extensions.add(ext);
    } else if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === 'content') hasContentSubfolder = true;

      // One level deeper — collect extensions + check for nested Content/
      let subEntries: Dirent[];
      try {
        subEntries = await readdir(join(root, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        if (sub.isFile()) {
          totalFiles += 1;
          const ext = extensionOf(sub.name);
          if (ext && !ARCHIVE_EXTS.has(ext)) extensions.add(ext);
        } else if (sub.isDirectory() && sub.name.toLowerCase() === 'content') {
          hasContentSubfolder = true;
        }
      }
    }
  }

  return {
    extensions,
    hasContentSubfolder,
    hasBlenderMarkers: hasBlenderInit || hasBlenderManifest,
    totalFiles,
  };
}

export function detectEcosystem(signals: EcosystemSignals): AssetEcosystem {
  const { extensions, hasContentSubfolder, hasBlenderMarkers, totalFiles } = signals;

  if (totalFiles === 0) return 'unknown';

  // Software-specific — order matters, most specific first.
  if (hasAny(extensions, UE_EXTS) || hasContentSubfolder) return 'unreal_engine';
  if (hasAny(extensions, BLENDER_EXTS) || hasBlenderMarkers) return 'blender';
  if (hasAny(extensions, ZBRUSH_EXTS)) return 'zbrush';
  if (hasAny(extensions, AFTER_EFFECTS_EXTS)) return 'after_effects';
  if (hasAny(extensions, CINEMA4D_EXTS)) return 'cinema4d';
  if (hasAny(extensions, MARVELOUS_EXTS)) return 'marvelous_designer';
  if (hasAny(extensions, SUBSTANCE_EXTS)) return 'substance';
  if (hasAny(extensions, UNITY_EXTS)) return 'unity';
  if (hasAny(extensions, MAYA_EXTS)) return 'maya';
  if (hasAny(extensions, MAX3DS_EXTS)) return '3ds_max';
  if (hasAny(extensions, HOUDINI_EXTS)) return 'houdini';

  // Generic categories
  if (hasAny(extensions, GENERAL_3D_EXTS)) return 'general_3d';
  if (isMajorityAudio(extensions)) return 'agnostic';

  // Non-empty folder with no recognized ecosystem. Classify as agnostic
  // rather than unknown so these assets still pass the orbital gate.
  return 'agnostic';
}

function hasAny(extensions: Set<string>, candidates: Set<string>): boolean {
  for (const ext of extensions) {
    if (candidates.has(ext)) return true;
  }
  return false;
}

function isMajorityAudio(extensions: Set<string>): boolean {
  if (extensions.size === 0) return false;
  let audio = 0;
  for (const ext of extensions) {
    if (AUDIO_EXTS.has(ext)) audio += 1;
  }
  return audio > extensions.size / 2;
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}
