import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * TypeScript port of `src-tauri/src/scanner/mod.rs::resolve_deepest_path`.
 *
 * Walks a scan-location subfolder down through single-child wrappers until it
 * finds the meaningful asset name. Handles the very common UE layout:
 *   `MyPack_v2/Content/MyPack/...` → resolves to `MyPack`.
 *
 * Rules (intentionally match the Rust implementation):
 *   - Stops at branches (more than one child directory)
 *   - Stops when the child name is a prefix/substring of the parent (repetition)
 *   - Walks through generic container names silently (Content, Assets, Data, …)
 *   - Requires non-generic children to be ≥4 chars AND (2+ word-length tokens
 *     OR total length ≥10)
 *   - Caps depth at 3 levels
 *
 * The resolver returns the deepest *meaningful* directory, never a generic
 * container. A real pack `City Sample/Content/{Maps,Blueprints,…}` resolves to
 * `City Sample` — descent steps through `Content` but, because the category
 * children branch, the walk stops there; returning that directory's basename
 * would mislabel the pack `Content`. Tracking the last non-generic directory
 * fixes that while still preferring an inner rename when one exists.
 */

const GENERIC_CONTAINER_NAMES = new Set([
  'assets',
  'organized',
  'content',
  'data',
  'pack',
  'source',
  'files',
  'unreal',
  'unreal engine 5',
  'unreal engine 4',
  'ue5',
  'ue4',
  'materials',
  'textures',
  'meshes',
  'blueprints',
  'sounds',
  'maps',
  'levels',
  'plugins',
]);

const MAX_DEPTH = 3;

export async function resolveDeepestPath(root: string): Promise<string> {
  let current = root;
  // The deepest directory whose basename is a real name (not a generic
  // container). Seeded with the pack folder itself so a pack that only nests
  // generic wrappers (`Pack/Content/{categories}`) keeps the pack's name
  // rather than inheriting `Content`.
  let bestPath = root;
  let parentName = basename(current).toLowerCase();

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      break;
    }
    const childDirs = entries.filter((e) => e.isDirectory());
    if (childDirs.length !== 1) break;

    const childName = childDirs[0].name;
    const childLower = childName.toLowerCase();

    // Reject repetition — FooPack/FooPack_2 or parent already contains child
    const isRepetition =
      parentName.length > 0 && (childLower.includes(parentName) || parentName.includes(childLower));
    if (isRepetition) break;

    const isGeneric = GENERIC_CONTAINER_NAMES.has(childLower);
    const qualifies =
      childName.length >= 4 && (countMeaningfulWords(childName) >= 2 || childName.length >= 10);

    if (!isGeneric && !qualifies) break;

    current = join(current, childName);
    // Only a non-generic step advances the chosen name; generic containers are
    // walked through but never become the asset name.
    if (!isGeneric) {
      parentName = childLower;
      bestPath = current;
    }
  }

  return bestPath;
}

function countMeaningfulWords(name: string): number {
  return name.split(/[^A-Za-z0-9]+/).filter((token) => token.length >= 3).length;
}
