import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AssetEcosystem, ScanDiagnostic, ScanDiagnosticKind } from '@omnidex/types/db';
import { collectEcosystemSignals, detectEcosystem } from './ecosystem';
import { resolveDeepestPath } from './name-resolver';

/**
 * Phase 2 scanner (incremental port of `src-tauri/src/scanner/mod.rs`).
 *
 * Detects asset packs at variable depth from the scan root. Two common
 * library layouts are supported:
 *
 *   1. Flat:       `root/PackName/Content/…`  (pack at depth 1)
 *   2. Categorized: `root/Category/PackName/…` (pack at depth 2+)
 *
 * A "pack" is any folder that contains `.uasset` / `.umap` files in its
 * subtree or has a `Content/` child. Non-pack folders at depth 1 still
 * surface as folder-style assets so loose libraries (tutorials, PDFs,
 * audio) aren't silently dropped.
 */

export interface DetectedAssetFolder {
  name: string;
  absolutePath: string;
  fileSize: number;
  fileCount: number;
  hasUassetFiles: boolean;
  ecosystem: AssetEcosystem;
  /**
   * True when the per-pack walk hit `MAX_FILES_PER_PACK` or
   * `MAX_DEPTH_PER_PACK` and stopped early, so `fileSize`/`fileCount` are
   * lower bounds rather than exact. Consumers must render these as
   * "26.7 GB+", never as a precise figure.
   */
  sizeIsPartial: boolean;
}

const UASSET_EXTENSIONS = new Set(['.uasset', '.umap']);
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.vs',
  'Intermediate',
  'DerivedDataCache',
  'Build',
  'Saved',
  'Binaries',
]);

/**
 * Standard UE pack-interior category names. A folder whose direct children
 * include 2+ of these names is almost certainly a pack's content root, not
 * a collection of packs. Prevents the walker from descending PAST the pack
 * boundary when a pack ships without a top-level `Content/` wrapper.
 *
 * Based on common UE marketplace asset layouts — see the `YI_BloodDecals`,
 * `2DAnimeV910584b68e50V1`, and similar patterns in the user's libraries.
 */
const UE_INTERIOR_CATEGORIES = new Set([
  'blueprints',
  'materials',
  'textures',
  'meshes',
  'maps',
  'levels',
  'sounds',
  'vfx',
  'particles',
  'characters',
  'animations',
  'niagara',
  'fx',
  'props',
  'sfx',
  'ui',
  'widgets',
  'fonts',
  'audio',
  'data',
  'input',
  'core',
  'engine',
  'abp',
  'animbp',
]);
const MIN_INTERIOR_SIGNALS = 2;

/**
 * Per-pack caps. Prevents a pathological multi-GB pack with hundreds of
 * thousands of files from blocking the scan on `fs.stat`. `hasUassetFiles`
 * is always correct once the flag trips; `fileSize` and `fileCount` are
 * lower bounds above the cap, and `DetectedAssetFolder.sizeIsPartial` says so.
 *
 * ponytail: the cap stays because the walker still issues one `fs.stat` per
 * file. Measured against the user's real library (`Assets\Organized`, 1,256
 * packs) 29 packs exceed it, so 2.3% of packs report a lower bound instead of
 * an exact size. Upgrade path: the MFT-based native scanner in
 * `docs/LIBRARY-SCALE-FINDINGS-2026-07-27.md` §4 retires both caps entirely.
 */
export const MAX_FILES_PER_PACK = 5000;
const MAX_DEPTH_PER_PACK = 8;

/**
 * Maximum depth from the scan root the pack-finder will descend. Cats out
 * at 4 — the deepest user layout we've seen (`Organized/Category/Subcat/
 * Pack/Content/…`) doesn't exceed this.
 */
const MAX_PACK_SEARCH_DEPTH = 4;

/**
 * Archive containers. A folder holding only these can never produce a
 * thumbnail or a `.uasset` match — 611 such folders (537 GB) in the audited
 * library rendered as blank cards with no explanation.
 */
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.gz', '.tar', '.bz2', '.xz', '.iso']);
/** Split-archive continuation parts: `.r00`, `.z01`, `.001`. */
const ARCHIVE_PART_RE = /^\.(r\d\d|z\d\d|\d{3})$/;

/**
 * Windows `MAX_PATH` is 260. Paths within 20 characters of it break naive
 * tools on any machine where the long-path policy is off — 594,815 files in
 * the audited library are past this mark, the longest at 610 characters.
 */
const LONG_PATH_THRESHOLD = 240;

/** Diagnostic kinds produced by the walk itself (vs. the thumbnail job). */
export const WALK_DIAGNOSTIC_KINDS: readonly ScanDiagnosticKind[] = [
  'archive-only',
  'depth-limit-abandoned',
  'path-near-max-length',
];

export interface WalkResult {
  folders: DetectedAssetFolder[];
  /** What the walk could not index, and why. Never thrown away. */
  diagnostics: ScanDiagnostic[];
}

/**
 * Walk a scan root, returning both the packs found and an account of what was
 * skipped. Prefer this over `walkRoot` — a scan that reports only its
 * successes makes "nothing there" and "we gave up" look identical.
 */
export interface WalkOptions {
  /**
   * Treat every immediate subfolder of the root as one asset and descend no
   * further.
   *
   * Pack detection is the wrong tool for a course library. It hunts for
   * `.uasset` files, a `Content/` directory, or UE-interior folder names, and
   * a video course routinely ships a UE sample project inside it — so the
   * finder walked past the course and registered `StackOBot`, "Class Project
   * File" and "Course Materials" as if each were a course of its own. On this
   * library that turned 51 courses into 211 rows, three-quarters of them
   * chapters and sample folders.
   *
   * A course is a folder you were handed. Depth 1, no heuristics.
   */
  readonly flat?: boolean;
}

export async function walkRootWithDiagnostics(
  root: string,
  options: WalkOptions = {},
): Promise<WalkResult> {
  // Phase 1: discover candidate folders.
  const { packs: candidates, diagnostics } = options.flat
    ? await findTopLevelFolders(root)
    : await findPackFolders(root);

  // Phase 2: enrich each candidate with stats + ecosystem + inferred name.
  const CONCURRENCY = 8;
  const results: DetectedAssetFolder[] = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (absolutePath) => {
        const [stats, signals, resolvedPath] = await Promise.all([
          aggregateDirectoryStats(absolutePath),
          collectEcosystemSignals(absolutePath),
          // Single-child unwrapping is a pack heuristic: it strips the
          // redundant `PackName/PackName/` wrapper archives ship with. A
          // course with exactly one chapter is not a wrapper, so in flat mode
          // the folder's own name is the answer — otherwise a one-chapter
          // course gets named after its chapter.
          options.flat ? Promise.resolve(absolutePath) : resolveDeepestPath(absolutePath),
        ]);
        return {
          name: basename(resolvedPath),
          absolutePath,
          fileSize: stats.size,
          fileCount: stats.count,
          hasUassetFiles: stats.hasUasset,
          ecosystem: detectEcosystem(signals),
          sizeIsPartial: stats.truncated,
          stats,
        };
      }),
    );
    for (const { stats, ...folder } of resolved) {
      results.push(folder);
      // One diagnostic per pack, not per file: a pack can hold thousands of
      // over-long paths and the actionable facts are "how many" and "which is
      // worst". Counts are bounded by the per-pack walk caps above.
      if (stats.longPathCount > 0 && stats.longestPath) {
        diagnostics.push({
          kind: 'path-near-max-length',
          path: stats.longestPath,
          detail: `${stats.longPathCount} file(s) at or past ${LONG_PATH_THRESHOLD} characters; longest is ${stats.longestPath.length} (MAX_PATH is 260)`,
        });
      }
    }
  }
  return { folders: results, diagnostics };
}

/** Folders-only view of {@link walkRootWithDiagnostics}. */
export async function walkRoot(root: string): Promise<DetectedAssetFolder[]> {
  return (await walkRootWithDiagnostics(root)).folders;
}

/**
 * Recursively discover pack folders starting below `root`. A folder is
 * treated as a pack when:
 *
 *   - it contains `.uasset` / `.umap` files directly, OR
 *   - it has a `Content/` subdirectory (UE convention), OR
 *   - we've reached `MAX_PACK_SEARCH_DEPTH` and its subtree holds
 *     `.uasset` files.
 *
 * Descent stops once a pack is recorded so that a pack's own subfolders
 * (Blueprints, Materials, …) don't pollute the grid. If no pack is found
 * under a depth-1 subfolder, the subfolder itself is recorded as a
 * folder-style asset so audio/PDF/tutorial packs still surface.
 */
/**
 * Every immediate subfolder of the root, and nothing below it. Used for
 * content locations (courses), where the folder handed to you IS the unit.
 */
async function findTopLevelFolders(root: string): Promise<{
  packs: string[];
  diagnostics: ScanDiagnostic[];
}> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { packs: [], diagnostics: [] };
  }
  const packs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIR_NAMES.has(e.name))
    .map((e) => join(root, e.name));
  return { packs, diagnostics: [] };
}

async function findPackFolders(root: string): Promise<{
  packs: string[];
  diagnostics: ScanDiagnostic[];
}> {
  const packs: string[] = [];
  const diagnostics: ScanDiagnostic[] = [];

  async function descend(dir: string, depth: number): Promise<boolean> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    let hasUassetHere = false;
    let hasContentDir = false;
    let interiorSignals = 0;
    let archiveCount = 0;
    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORED_DIR_NAMES.has(e.name)) continue;
      if (e.isFile()) {
        const dot = e.name.lastIndexOf('.');
        const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : '';
        if (UASSET_EXTENSIONS.has(ext)) hasUassetHere = true;
        if (ARCHIVE_EXTENSIONS.has(ext) || ARCHIVE_PART_RE.test(ext)) archiveCount += 1;
      } else if (e.isDirectory()) {
        if (e.name.toLowerCase() === 'content') hasContentDir = true;
        if (UE_INTERIOR_CATEGORIES.has(e.name.toLowerCase())) interiorSignals += 1;
        subdirs.push(e.name);
      }
    }

    // A folder whose children look like UE pack internals (Blueprints,
    // Materials, Textures, …) is the pack root itself. Record it and
    // stop — the internals are pack contents, not separate packs.
    if (interiorSignals >= MIN_INTERIOR_SIGNALS) {
      packs.push(dir);
      return true;
    }

    if (hasUassetHere || hasContentDir) {
      packs.push(dir);
      return true;
    }

    if (depth >= MAX_PACK_SEARCH_DEPTH) {
      if (await subtreeHasUasset(dir, 2)) {
        packs.push(dir);
        return true;
      }
      // The drop this whole feature exists for. An unextracted archive pile
      // and a pack buried one level too deep both used to vanish here with
      // no trace; they need different fixes, so report them separately.
      diagnostics.push(
        archiveCount > 0
          ? archiveDiagnostic(dir, archiveCount)
          : {
              kind: 'depth-limit-abandoned',
              path: dir,
              detail: `reached the depth-${MAX_PACK_SEARCH_DEPTH} search limit with no .uasset within 2 levels below it`,
            },
      );
      return false;
    }

    let anyChildIsPack = false;
    for (const name of subdirs) {
      const childIsPack = await descend(join(dir, name), depth + 1);
      if (childIsPack) anyChildIsPack = true;
    }

    if (!anyChildIsPack) {
      // Archives here and no pack under them: the content is real but sealed.
      // Reported whether or not the depth-1 fallback below turns it into a
      // card, because a card with no thumbnail is exactly the symptom that
      // sent the user hunting for a thumbnail bug.
      if (archiveCount > 0) diagnostics.push(archiveDiagnostic(dir, archiveCount));

      // Loose-content fallback: if a top-level folder has no pack descendants
      // (e.g. a zipped archive pile or a PDF library), register it anyway.
      if (depth === 1) packs.push(dir);
    }
    return anyChildIsPack;
  }

  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return { packs, diagnostics };
  }
  for (const e of rootEntries) {
    if (e.name.startsWith('.') || IGNORED_DIR_NAMES.has(e.name)) continue;
    if (e.isDirectory()) {
      await descend(join(root, e.name), 1);
    }
  }
  return { packs, diagnostics };
}

function archiveDiagnostic(dir: string, archiveCount: number): ScanDiagnostic {
  return {
    kind: 'archive-only',
    path: dir,
    detail: `${archiveCount} archive(s) and no extracted content — nothing to index or thumbnail until extracted`,
  };
}

async function subtreeHasUasset(dir: string, maxDepth: number): Promise<boolean> {
  if (maxDepth < 0) return false;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORED_DIR_NAMES.has(e.name)) continue;
    if (e.isFile()) {
      const dot = e.name.lastIndexOf('.');
      if (dot >= 0 && UASSET_EXTENSIONS.has(e.name.slice(dot).toLowerCase())) {
        return true;
      }
    }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || IGNORED_DIR_NAMES.has(e.name)) continue;
    if (await subtreeHasUasset(join(dir, e.name), maxDepth - 1)) return true;
  }
  return false;
}

interface DirStats {
  size: number;
  count: number;
  hasUasset: boolean;
  /** Set once either per-pack cap cuts the walk short. See `sizeIsPartial`. */
  truncated: boolean;
  /**
   * Files at or past `LONG_PATH_THRESHOLD`. Bounded by the same per-pack caps
   * as `count`, so this is a lower bound on a truncated pack.
   */
  longPathCount: number;
  /** The single worst path seen — what the user actually needs to shorten. */
  longestPath: string | null;
}

async function aggregateDirectoryStats(dir: string): Promise<DirStats> {
  const stats: DirStats = {
    size: 0,
    count: 0,
    hasUasset: false,
    truncated: false,
    longPathCount: 0,
    longestPath: null,
  };
  await walkRecursive(dir, stats, 0);
  return stats;
}

async function walkRecursive(dir: string, stats: DirStats, depth: number): Promise<void> {
  if (stats.count >= MAX_FILES_PER_PACK) {
    stats.truncated = true;
    return;
  }
  if (depth >= MAX_DEPTH_PER_PACK) {
    // Only a truncation if there is actually something down here to miss. An
    // empty (or unreadable) directory at the depth limit costs no bytes.
    if (await hasAnyEntry(dir)) stats.truncated = true;
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.isFile()) continue;
    if (stats.count >= MAX_FILES_PER_PACK) {
      stats.truncated = true;
      return;
    }

    stats.count += 1;
    const fullPath = join(dir, entry.name);
    if (fullPath.length >= LONG_PATH_THRESHOLD) {
      stats.longPathCount += 1;
      if (fullPath.length > (stats.longestPath?.length ?? 0)) stats.longestPath = fullPath;
    }
    if (!stats.hasUasset) {
      const dot = entry.name.lastIndexOf('.');
      if (dot >= 0) {
        const ext = entry.name.slice(dot).toLowerCase();
        if (UASSET_EXTENSIONS.has(ext)) stats.hasUasset = true;
      }
    }
    // Sum the size of every enumerated file, not just the first 200. The walk
    // is already bounded by `MAX_FILES_PER_PACK`, so this is at most one extra
    // `fs.stat` per counted file (the same stat we already issue) and the total
    // is exact for any pack up to the cap. The previous `count <= 200` guard
    // silently dropped every byte past file #200, so a typical multi-thousand-
    // file UE pack reported a tiny fraction of its real size on disk.
    try {
      const info = await stat(fullPath);
      stats.size += info.size;
    } catch {
      /* ignore transient I/O errors */
    }
  }

  for (const entry of entries) {
    if (stats.count >= MAX_FILES_PER_PACK) {
      stats.truncated = true;
      return;
    }
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    await walkRecursive(join(dir, entry.name), stats, depth + 1);
  }
}

/** Cheap "is this directory non-empty?" probe — reads one entry, not the tree. */
async function hasAnyEntry(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}
