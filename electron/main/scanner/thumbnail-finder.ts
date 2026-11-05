import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Locate something inside an asset folder we can show as its thumbnail. Walks
 * breadth-first up to a depth limit so we don't burn time on deep content trees
 * when the pack's hero asset is near the root.
 *
 * Two kinds of result, because they're consumed differently:
 *
 * - `uasset` — a UE `.uasset`, which still has to go through the native
 *   extractor in `native/uasset` to get a PNG out of it.
 * - `image`  — a plain preview image shipped by the pack, usable as-is.
 *
 * The image fallback exists because packs shipping FBX/OBJ/Blend source (757 GB
 * of this library from BigMediumSmall vendor packs alone) contain no `.uasset`
 * at all and could previously never show a preview, regardless of folder
 * layout. Most such packs ship a preview image at or near the pack root. See
 * `docs/LIBRARY-SCALE-FINDINGS-2026-07-27.md` §3.
 */
const MAX_DEPTH = 4;
const MAX_DIRS_VISITED = 200;
const IGNORE = new Set([
  'Intermediate',
  'DerivedDataCache',
  'Build',
  'Saved',
  'Binaries',
  'node_modules',
  '.git',
]);
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
/**
 * Utility textures whose embedded thumbnail is a flat swatch: a pack card that
 * shows a black square is worse than one that keeps looking. Matches names like
 * `Black.uasset`, `T_White_Linear.uasset`, `Default_Mask.uasset`.
 */
const UTILITY_ASSET_RE =
  /^(t_)?(black|white|gr[ae]y|default|flat|blank|empty|null|dummy|placeholder|mask|noise|checker)(_(linear|srgb|mask|normal|n))?\.uasset$/i;
/** Stop collecting past this many images — BFS order means the ones we keep are the shallowest. */
const MAX_IMAGE_CANDIDATES = 64;
/** Below this, an image is almost certainly a UI icon rather than a pack preview. */
const MIN_IMAGE_BYTES = 4096;

/**
 * `fallback` on a `uasset` source is a preview image found at the same or a
 * shallower depth. Many `.uasset` files carry no embedded thumbnail (material
 * instances, textures, cooked or very new engine versions), and the pack's own
 * preview image is a better card than a blank one.
 */
export type ThumbnailSource =
  | { kind: 'uasset'; path: string; fallback?: string }
  | { kind: 'image'; path: string };

export async function findThumbnailSource(root: string): Promise<ThumbnailSource | null> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  // Collected during the same walk rather than in a second pass — by the time
  // we know there's no `.uasset` we've already read every dirent we're allowed
  // to look at, so re-reading them would just cost a second round of syscalls.
  // BFS pops in non-decreasing depth order, so this list stays depth-sorted and
  // the cap above discards the deepest candidates, which are the least likely
  // to be the pack's hero image.
  const images: Array<{ path: string; depth: number }> = [];
  // First utility swatch seen, used only if the walk finds no real asset.
  let utilityAsset: string | null = null;
  let visited = 0;

  while (queue.length > 0) {
    if (visited++ > MAX_DIRS_VISITED) break;
    const { dir, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Check files at this level first — pack thumbnails usually live near the top.
    // The whole level is read even after a `.uasset` turns up, so a preview
    // image sitting beside it can serve as the fallback.
    let uasset: string | null = null;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.uasset')) {
        if (UTILITY_ASSET_RE.test(entry.name)) utilityAsset ??= join(dir, entry.name);
        else uasset ??= join(dir, entry.name);
        continue;
      }
      if (images.length < MAX_IMAGE_CANDIDATES && IMAGE_EXTENSIONS.some((e) => lower.endsWith(e))) {
        images.push({ path: join(dir, entry.name), depth });
      }
    }
    if (uasset) {
      const hero = await pickHeroImage(images);
      return hero ? { kind: 'uasset', path: uasset, fallback: hero.path } : { kind: 'uasset', path: uasset };
    }
    if (depth >= MAX_DEPTH) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !IGNORE.has(entry.name)) {
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      }
    }
  }

  if (utilityAsset) {
    const hero = await pickHeroImage(images);
    return hero
      ? { kind: 'uasset', path: utilityAsset, fallback: hero.path }
      : { kind: 'uasset', path: utilityAsset };
  }
  return pickHeroImage(images);
}

/**
 * Pick the most likely hero image: shallowest wins, largest breaks the tie.
 * Depth beats size because vendor packs put the real preview at the pack root
 * and their bulk textures deeper; the size floor stops a root-level 1 KB icon
 * from outranking a genuine preview that sits one level down.
 */
async function pickHeroImage(
  candidates: Array<{ path: string; depth: number }>,
): Promise<ThumbnailSource | null> {
  if (candidates.length === 0) return null;

  const sized = (
    await Promise.all(
      candidates.map(async (c) => {
        try {
          return { ...c, size: (await stat(c.path)).size };
        } catch {
          return null;
        }
      }),
    )
  ).filter((c): c is { path: string; depth: number; size: number } => c !== null);
  if (sized.length === 0) return null;

  const aboveFloor = sized.filter((c) => c.size >= MIN_IMAGE_BYTES);
  const pool = aboveFloor.length > 0 ? aboveFloor : sized;
  const shallowest = Math.min(...pool.map((c) => c.depth));
  const best = pool
    .filter((c) => c.depth === shallowest)
    // Path tiebreak keeps the choice stable across filesystems, whose readdir
    // order is not guaranteed.
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))[0];

  return { kind: 'image', path: best.path };
}
