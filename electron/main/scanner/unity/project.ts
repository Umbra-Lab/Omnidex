import { createReadStream, type Dirent } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isReferencingKind, type UnityAssetKind, unityKindOf, wantsOutline } from './kinds';
import { type UnityOutline, UnityYamlReader } from './yaml';

/**
 * Finding and reading Unity projects on disk. Everything here is read-only: it never
 * opens a file for writing and never needs the Editor. Of `Library/` (Unity's regenerable
 * cache, often tens of GB) it reads only the `.meta` files under `Library/PackageCache`,
 * to learn which package each built-in GUID belongs to.
 */

/**
 * Folders never worth walking while looking for projects and packages. Inside a project's
 * `Assets/` only Unity's own rules apply (see `ignoredByUnity`): `Assets/Scripts/Build`
 * is an ordinary asset folder.
 */
const SKIPPED_DIRS = new Set([
  'library',
  'temp',
  'logs',
  'obj',
  'build',
  'builds',
  'usersettings',
  'memorycaptures',
  'recordings',
  'node_modules',
  '.git',
  '.vs',
  '.idea',
  '__macosx',
]);

/** How deep under a scan root to look for project folders and packages. */
const MAX_DISCOVERY_DEPTH = 5;

export interface UnityDiscovery {
  projects: string[];
  packages: string[];
  /** Folders that could not be listed; what was indexed under them must not be pruned. */
  unreadable: string[];
}

export async function isUnityProject(dir: string): Promise<boolean> {
  try {
    const [assets, version] = await Promise.all([
      stat(join(dir, 'Assets')),
      stat(join(dir, 'ProjectSettings', 'ProjectVersion.txt')),
    ]);
    return assets.isDirectory() && version.isFile();
  } catch {
    return false;
  }
}

/** Unity skips hidden folders, folders ending in `~`, and `cvs`; so does Omnidex. */
function ignoredByUnity(name: string): boolean {
  return name.startsWith('.') || name.endsWith('~') || name.toLowerCase() === 'cvs';
}

/**
 * Find Unity projects and `.unitypackage` files under `root`. A project is not descended
 * into: its contents are read by `listProjectFiles`. The root itself must be readable,
 * so an unplugged drive fails the scan instead of looking empty.
 */
export async function discoverUnity(root: string, signal?: AbortSignal): Promise<UnityDiscovery> {
  const projects: string[] = [];
  const packages: string[] = [];
  const unreadable: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (await isUnityProject(dir)) {
      projects.push(dir);
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (depth === 0) throw error;
      unreadable.push(dir);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignoredByUnity(entry.name) || SKIPPED_DIRS.has(entry.name.toLowerCase())) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.unitypackage') {
        packages.push(path);
      } else if (entry.isDirectory() && depth < MAX_DISCOVERY_DEPTH) {
        await visit(path, depth + 1);
      }
    }
  }
  await visit(root, 0);
  return { projects, packages, unreadable };
}

export interface UnityProjectInfo {
  name: string;
  root: string;
  editorVersion: string | null;
  renderPipeline: 'urp' | 'hdrp' | 'built-in';
  /** Package name to version (or local path/git URL) from Packages/manifest.json. */
  packages: Record<string, string>;
}

export async function readProjectInfo(root: string): Promise<UnityProjectInfo> {
  let editorVersion: string | null = null;
  try {
    const text = await readFile(join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8');
    editorVersion = /m_EditorVersion:\s*(\S+)/.exec(text)?.[1] ?? null;
  } catch {
    editorVersion = null;
  }
  let packages: Record<string, string> = {};
  try {
    const manifest = JSON.parse(await readFile(join(root, 'Packages', 'manifest.json'), 'utf8'));
    if (manifest && typeof manifest.dependencies === 'object' && manifest.dependencies) {
      packages = Object.fromEntries(
        Object.entries(manifest.dependencies as Record<string, unknown>).map(([k, v]) => [
          k,
          String(v),
        ]),
      );
    }
  } catch {
    packages = {};
  }
  const renderPipeline = Object.hasOwn(packages, 'com.unity.render-pipelines.high-definition')
    ? 'hdrp'
    : Object.hasOwn(packages, 'com.unity.render-pipelines.universal')
      ? 'urp'
      : 'built-in';
  return { name: basename(root), root, editorVersion, renderPipeline, packages };
}

export interface UnityFileEntry {
  /** Forward-slash path relative to the project root, e.g. `Assets/Prefabs/Ship.prefab`. */
  relPath: string;
  absPath: string;
  name: string;
  kind: UnityAssetKind;
  size: number;
  /** Newest of the file's and its .meta's modification times. */
  mtimeMs: number;
}

/** List every asset file under `Assets/` and any embedded package under `Packages/`. */
export async function listProjectFiles(
  root: string,
  signal?: AbortSignal,
): Promise<UnityFileEntry[]> {
  const files: UnityFileEntry[] = [];
  async function walk(dir: string): Promise<void> {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      if (ignoredByUnity(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith('.meta')) continue;
      try {
        const info = await stat(path);
        let mtimeMs = info.mtimeMs;
        if (names.has(`${entry.name}.meta`)) {
          mtimeMs = Math.max(mtimeMs, (await stat(`${path}.meta`)).mtimeMs);
        }
        files.push({
          relPath: relative(root, path).split(sep).join('/'),
          absPath: path,
          name: entry.name,
          kind: unityKindOf(entry.name),
          size: info.size,
          mtimeMs: Math.trunc(mtimeMs),
        });
      } catch {
        // Vanished mid-walk; the next scan will see the truth.
      }
    }
  }
  await walk(join(root, 'Assets'));
  // Embedded packages are folders under Packages/; manifest.json and the lock file are not assets.
  try {
    for (const entry of await readdir(join(root, 'Packages'), { withFileTypes: true })) {
      if (entry.isDirectory() && !ignoredByUnity(entry.name)) {
        await walk(join(root, 'Packages', entry.name));
      }
    }
  } catch {
    // No Packages/ folder: an old or partial project.
  }
  return files;
}

/** The GUID from an asset's `.meta` sidecar (it sits on the second line). */
export function readMetaGuid(assetPath: string): Promise<string | null> {
  return readGuidFrom(`${assetPath}.meta`);
}

async function readGuidFrom(metaPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(metaPath, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    return /guid:\s*([0-9a-f]{32})/.exec(buffer.toString('utf8', 0, bytesRead))?.[1] ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export interface PackageCacheEntry {
  package: string;
  version: string;
  /** GUID to the file's path inside the package, e.g. `Shaders/Lit.shader`. */
  guids: Map<string, string>;
  /** False when the read stopped at the file budget; read it again next scan. */
  complete: boolean;
}

/** Most `.meta` files read from one project's PackageCache in one scan. */
const MAX_PACKAGE_CACHE_METAS = 50_000;
/** `.meta` files read at once; the cache often sits on a slow or network drive. */
const META_READ_CONCURRENCY = 8;

/**
 * GUIDs of the packages in a project's `Library/PackageCache`, one entry per
 * `name@version` folder that `alreadyRead` does not claim. `Tests/` folders are skipped:
 * content never references them. Missing or unreadable folders yield nothing.
 */
export async function readPackageCache(
  root: string,
  alreadyRead: (name: string, version: string) => boolean,
  signal?: AbortSignal,
): Promise<PackageCacheEntry[]> {
  const cache = join(root, 'Library', 'PackageCache');
  let folders: Dirent[];
  try {
    folders = await readdir(cache, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: PackageCacheEntry[] = [];
  let budget = MAX_PACKAGE_CACHE_METAS;
  for (const folder of folders) {
    signal?.throwIfAborted();
    const at = folder.name.lastIndexOf('@');
    if (!folder.isDirectory() || at <= 0) continue;
    const dir = join(cache, folder.name);
    const name = folder.name.slice(0, at);
    // Unity 6 names folders name@<hash>; package.json holds the real version.
    let version = folder.name.slice(at + 1);
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (typeof manifest?.version === 'string' && manifest.version) version = manifest.version;
    } catch {
      // No readable package.json: keep the folder's suffix.
    }
    if (alreadyRead(name, version)) continue;

    const metas: string[] = [];
    async function walk(at: string): Promise<void> {
      signal?.throwIfAborted();
      let entries: Dirent[];
      try {
        entries = await readdir(at, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (ignoredByUnity(entry.name)) continue;
        const path = join(at, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'Tests') await walk(path);
        } else if (entry.isFile() && entry.name.endsWith('.meta') && metas.length < budget) {
          metas.push(path);
        }
      }
    }
    await walk(dir);
    const complete = metas.length < budget;
    budget -= metas.length;

    const guids = new Map<string, string>();
    let next = 0;
    const worker = async () => {
      while (next < metas.length) {
        signal?.throwIfAborted();
        const meta = metas[next++];
        const guid = await readGuidFrom(meta);
        if (guid) guids.set(guid, relative(dir, meta.slice(0, -5)).split(sep).join('/'));
      }
    };
    await Promise.all(Array.from({ length: META_READ_CONCURRENCY }, worker));
    result.push({ package: name, version, guids, complete });
    if (budget <= 0) break;
  }
  return result;
}

export interface UnityFileContents {
  serialization: 'text' | 'binary' | 'none';
  /** The file could not be read; store it so a later scan retries it. */
  failed?: boolean;
  refs: string[];
  variantOf: string | null;
  outline: UnityOutline | null;
}

/** Stream a text-serialized asset line by line; binary assets stop after the first line. */
export async function readProjectFile(
  entry: UnityFileEntry,
  guid: string | null,
): Promise<UnityFileContents> {
  if (!isReferencingKind(entry.kind)) {
    return { serialization: 'none', refs: [], variantOf: null, outline: null };
  }
  // Sniff before streaming: readline would buffer a binary file's whole first "line".
  if (!(await looksLikeText(entry.absPath))) {
    return { serialization: 'binary', refs: [], variantOf: null, outline: null };
  }
  const reader = new UnityYamlReader({
    outline: wantsOutline(entry.kind),
    prefab: entry.kind === 'prefab',
    selfGuid: guid,
  });
  try {
    for await (const line of boundedLines(entry.absPath)) {
      reader.push(line);
      if (!reader.wantsMore) break;
    }
  } catch {
    return { serialization: 'none', failed: true, refs: [], variantOf: null, outline: null };
  }
  const result = reader.finish();
  return {
    serialization: result.serialization,
    refs: [...result.refs],
    variantOf: result.variantOf,
    outline: result.outline,
  };
}

/** Unity text assets open with `%YAML`; Shader Graph and friends are JSON. */
async function looksLikeText(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, 64, 0);
    const head = buffer
      .toString('utf8', 0, bytesRead)
      .replace(/^\uFEFF/, '')
      .trimStart();
    return head.startsWith('%YAML') || head.startsWith('{');
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Longest line kept. GUIDs sit near a line's start; the rest is mesh or terrain hex. */
const MAX_LINE = 64 * 1024;

/**
 * Lines of a file, each cut to `MAX_LINE` characters. Text-serialized meshes and terrains
 * put hundreds of megabytes of hex on one line, which readline would buffer whole.
 */
export async function* boundedLines(path: string, max = MAX_LINE): AsyncGenerator<string> {
  const stream = createReadStream(path);
  const decoder = new StringDecoder('utf8');
  let line = '';
  let overflow = false;
  const take = (piece: string) => {
    if (overflow) return;
    line += piece;
    if (line.length > max) {
      line = line.slice(0, max);
      overflow = true;
    }
  };
  try {
    for await (const chunk of stream) {
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      while (true) {
        const end = text.indexOf('\n', start);
        if (end === -1) {
          take(text.slice(start));
          break;
        }
        take(text.slice(start, end));
        yield line.endsWith('\r') ? line.slice(0, -1) : line;
        line = '';
        overflow = false;
        start = end + 1;
      }
    }
    take(decoder.end());
    if (line !== '') yield line.endsWith('\r') ? line.slice(0, -1) : line;
  } finally {
    stream.destroy();
  }
}
