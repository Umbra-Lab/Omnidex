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

export interface UnityAssetFolder {
  /** The folder holding `Assets/`, e.g. a course chapter's `c04_.../`. */
  root: string;
  /** The Unity project it sits inside, whose settings it shares; null when on its own. */
  project: string | null;
}

export interface UnityDiscovery {
  projects: string[];
  packages: string[];
  /**
   * `Assets/` folders with no `ProjectSettings/` beside them: chapter folders a course
   * ships inside or next to its project, or an `Assets/` copied out on its own.
   */
  assetFolders: UnityAssetFolder[];
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

/** A missing path, as opposed to one that exists but could not be read this time. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Whether `dir/Assets` exists and holds `.meta` files, the mark of Unity content.
 * `unreadable` when it exists but could not be listed (a locked or flaky drive), so the
 * caller keeps what was indexed there instead of pruning it.
 */
async function hasAssetsFolder(dir: string): Promise<boolean | 'unreadable'> {
  try {
    const names = await readdir(join(dir, 'Assets'));
    return names.some((name) => name.endsWith('.meta'));
  } catch (error) {
    return isMissing(error) ? false : 'unreadable';
  }
}

/** A project's own top-level folders; anything else holding Assets/ is extra content. */
const PROJECT_DIRS = new Set(['assets', 'packages', 'projectsettings']);

interface NestedFound {
  /** Full projects (with their own ProjectSettings) nested inside the project. */
  projects: string[];
  /** Assets-only folders inside the project but outside its own Assets/. */
  assetFolders: string[];
  unreadable: string[];
}

/** What a project holds beside its own Assets/ and Packages/, up to three levels down. */
async function findNested(projectRoot: string, signal?: AbortSignal): Promise<NestedFound> {
  const found: NestedFound = { projects: [], assetFolders: [], unreadable: [] };
  async function visit(dir: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) found.unreadable.push(dir);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      if (!entry.isDirectory() || ignoredByUnity(entry.name) || SKIPPED_DIRS.has(lower)) continue;
      if (depth === 0 && PROJECT_DIRS.has(lower)) continue;
      const path = join(dir, entry.name);
      if (await isUnityProject(path)) {
        found.projects.push(path);
        continue;
      }
      const assets = await hasAssetsFolder(path);
      if (assets === 'unreadable') found.unreadable.push(path);
      else if (assets) found.assetFolders.push(path);
      else if (depth < 2) await visit(path, depth + 1);
    }
  }
  await visit(projectRoot, 0);
  return found;
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
  const assetFolders: UnityAssetFolder[] = [];
  const unreadable: string[] = [];
  async function addProject(dir: string): Promise<void> {
    projects.push(dir);
    const nested = await findNested(dir, signal);
    unreadable.push(...nested.unreadable);
    for (const root of nested.assetFolders) assetFolders.push({ root, project: dir });
    for (const inner of nested.projects) await addProject(inner);
  }
  async function visit(dir: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (await isUnityProject(dir)) {
      await addProject(dir);
      return;
    }
    // A loose Assets/ is recorded, and the walk goes on: packages and projects can sit
    // beside it, and missing them here would prune them.
    const assets = await hasAssetsFolder(dir);
    if (assets === 'unreadable') unreadable.push(dir);
    else if (assets) assetFolders.push({ root: dir, project: null });
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
      const lower = entry.name.toLowerCase();
      if (ignoredByUnity(entry.name) || SKIPPED_DIRS.has(lower)) continue;
      // The loose folder's own Assets/ (and Packages/) belong to its container.
      if (assets === true && entry.isDirectory() && PROJECT_DIRS.has(lower)) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.unitypackage') {
        packages.push(path);
      } else if (entry.isDirectory() && depth < MAX_DISCOVERY_DEPTH) {
        await visit(path, depth + 1);
      }
    }
  }
  await visit(root, 0);
  return { projects, packages, assetFolders, unreadable };
}

export interface UnityProjectInfo {
  name: string;
  root: string;
  editorVersion: string | null;
  /** `unknown` for an Assets/ folder with no project settings to read. */
  renderPipeline: 'urp' | 'hdrp' | 'built-in' | 'unknown';
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
  return { name: repairZipName(basename(root)), root, editorVersion, renderPipeline, packages };
}

/** cp437's upper half, which is how most zip tools decode a name with no UTF-8 flag. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

/**
 * Undo the garbling a Korean folder name gets when a zip made on a Korean Windows is
 * unpacked elsewhere: its CP949 bytes come out as cp437 box-drawing characters, so
 * `c04_░╘└╙` was `c04_게임`. Only for display; the folder keeps its name on disk. A name
 * that does not decode cleanly to Hangul is returned as it is.
 */
export function repairZipName(name: string): string {
  if (!/[\u2500-\u25ff]/.test(name)) return name;
  const bytes: number[] = [];
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const index = CP437_HIGH.indexOf(ch);
    if (index < 0) return name;
    bytes.push(0x80 + index);
  }
  try {
    const text = new TextDecoder('euc-kr', { fatal: true }).decode(Uint8Array.from(bytes));
    return /[\uac00-\ud7a3]/.test(text) ? text : name;
  } catch {
    return name;
  }
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
  try {
    return await readGuidStrict(metaPath);
  } catch {
    return null;
  }
}

/** Like readGuidFrom, but a failed read throws instead of looking like "no GUID". */
async function readGuidStrict(metaPath: string): Promise<string | null> {
  const handle = await open(metaPath, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    return /guid:\s*([0-9a-f]{32})/.exec(buffer.toString('utf8', 0, bytesRead))?.[1] ?? null;
  } finally {
    await handle.close();
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
    let version = folder.name.slice(at + 1);
    // Older Unity names folders name@1.2.3, which is the version. Unity 6 uses
    // name@<hash>, and only then is package.json worth a read on every scan.
    if (!/^\d+\.\d+/.test(version)) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        if (typeof manifest?.version === 'string' && manifest.version) version = manifest.version;
      } catch {
        // No readable package.json: keep the folder's suffix.
      }
    }
    if (alreadyRead(name, version)) continue;

    // A folder that fails to list leaves the package incomplete, so a later scan tries again.
    let failed = false;
    let truncated = false;
    const metas: string[] = [];
    async function walk(at: string): Promise<void> {
      signal?.throwIfAborted();
      let entries: Dirent[];
      try {
        entries = await readdir(at, { withFileTypes: true });
      } catch {
        failed = true;
        return;
      }
      for (const entry of entries) {
        if (ignoredByUnity(entry.name)) continue;
        const path = join(at, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase() !== 'tests') await walk(path);
        } else if (entry.isFile() && entry.name.endsWith('.meta')) {
          if (metas.length < budget) metas.push(path);
          else truncated = true;
        }
      }
    }
    await walk(dir);
    budget -= metas.length;

    const guids = new Map<string, string>();
    let next = 0;
    const worker = async () => {
      while (next < metas.length) {
        signal?.throwIfAborted();
        const meta = metas[next++];
        let guid: string | null = null;
        try {
          guid = await readGuidStrict(meta);
        } catch {
          // One unreadable .meta is skipped, not retried: a file that fails every time
          // would otherwise have the whole package re-read on every scan.
        }
        if (guid) guids.set(guid, relative(dir, meta.slice(0, -5)).split(sep).join('/'));
      }
    };
    await Promise.all(Array.from({ length: META_READ_CONCURRENCY }, worker));
    result.push({ package: name, version, guids, complete: !truncated && !failed });
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
