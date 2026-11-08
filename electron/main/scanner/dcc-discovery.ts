import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type { AssetEcosystem } from '@omnidex/types/db';

export type DccFileKind = 'scene' | 'mesh' | 'material' | 'brush' | 'archive' | 'texture_set';
export interface DccFile {
  name: string;
  path: string;
  relativePath: string;
  kind: DccFileKind;
  ecosystem: AssetEcosystem;
  size: number;
  searchTerms?: string;
}

const formats: Record<string, [DccFileKind, AssetEcosystem]> = {
  '.blend': ['scene', 'blender'],
  '.ma': ['scene', 'maya'],
  '.mb': ['scene', 'maya'],
  '.ztl': ['scene', 'zbrush'],
  '.zpr': ['scene', 'zbrush'],
  '.hip': ['scene', 'houdini'],
  '.hipnc': ['scene', 'houdini'],
  '.hiplc': ['scene', 'houdini'],
  '.hda': ['scene', 'houdini'],
  '.otl': ['scene', 'houdini'],
  '.c4d': ['scene', 'cinema4d'],
  '.max': ['scene', '3ds_max'],
  '.fbx': ['mesh', 'general_3d'],
  '.obj': ['mesh', 'general_3d'],
  '.gltf': ['mesh', 'general_3d'],
  '.glb': ['mesh', 'general_3d'],
  '.usd': ['mesh', 'general_3d'],
  '.usda': ['mesh', 'general_3d'],
  '.usdc': ['mesh', 'general_3d'],
  '.abc': ['mesh', 'general_3d'],
  '.sbs': ['material', 'substance'],
  '.sbsar': ['material', 'substance'],
  '.spp': ['material', 'substance'],
  '.tor': ['scene', 'gaea'],
  '.zprj': ['scene', 'marvelous_designer'],
  '.avt': ['scene', 'marvelous_designer'],
  '.zbp': ['brush', 'zbrush'],
  '.zbr': ['brush', 'zbrush'],
  '.abr': ['brush', 'agnostic'],
  '.zpac': ['scene', 'marvelous_designer'],
  '.unitypackage': ['archive', 'unity'],
  '.zip': ['archive', 'agnostic'],
  '.rar': ['archive', 'agnostic'],
  '.7z': ['archive', 'agnostic'],
  '.tar': ['archive', 'agnostic'],
  '.gz': ['archive', 'agnostic'],
  '.bz2': ['archive', 'agnostic'],
  '.xz': ['archive', 'agnostic'],
};
const ignored = new Set([
  'node_modules',
  '.git',
  '.svn',
  '__macosx',
  'intermediate',
  'deriveddatacache',
  'binaries',
  'saved',
]);

/** Enumerate identifiable files without following links or opening asset contents. */
export async function discoverDccFiles(root: string, signal?: AbortSignal): Promise<DccFile[]> {
  const found: DccFile[] = [];
  async function visit(dir: string): Promise<void> {
    signal?.throwIfAborted();
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    let textureCount = 0;
    let textureSize = 0;
    const textureNames: string[] = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name.startsWith('.') || ignored.has(entry.name.toLowerCase())) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        const format = Object.hasOwn(formats, extension) ? formats[extension] : undefined;
        if (format)
          found.push({
            name: entry.name,
            path,
            relativePath: relative(root, path),
            kind: format[0],
            ecosystem: format[1],
            size: (await stat(path)).size,
          });
        else if (
          /\.(png|jpe?g|tiff?|exr|tga|bmp)$/i.test(entry.name) &&
          /(?:base.?colou?r|albedo|diffuse|normal|roughness|metallic|displacement|height|ambient.?occlusion|(?:^|[_ .-])ao(?:[_ .-]|\.))/i.test(
            entry.name,
          )
        ) {
          textureCount += 1;
          textureSize += (await stat(path)).size;
          textureNames.push(entry.name);
        }
      }
    }
    if (textureCount >= 2) {
      found.push({
        name: basename(dir),
        path: dir,
        relativePath: relative(root, dir),
        kind: 'texture_set',
        ecosystem: 'agnostic',
        size: textureSize,
        searchTerms: textureNames.join(' '),
      });
    }
  }
  await visit(root);
  return found;
}
