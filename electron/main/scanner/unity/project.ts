import { createReadStream, type Dirent } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { isReferencingKind, type UnityAssetKind, unityKindOf, wantsOutline } from './kinds';
import { type UnityOutline, UnityYamlReader } from './yaml';

/**
 * Finding and reading Unity projects on disk. Everything here is read-only: it never
 * opens a file for writing, never touches `Library/` (Unity's regenerable cache, often
 * tens of GB), and never needs the Editor.
 */

/** Folders Unity itself regenerates or ignores; never worth walking. */
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

/** Unity skips hidden folders and folders ending in `~`; so does Omnidex. */
function ignoredByUnity(name: string): boolean {
  return name.startsWith('.') || name.endsWith('~');
}

/**
 * Find Unity projects and `.unitypackage` files under `root`. A project is not descended
 * into for more projects; packages inside a project's `Assets/` are picked up.
 */
export async function discoverUnity(root: string, signal?: AbortSignal): Promise<UnityDiscovery> {
  const projects: string[] = [];
  const packages: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (await isUnityProject(dir)) {
      projects.push(dir);
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
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
  return { projects, packages };
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
        if (!SKIPPED_DIRS.has(entry.name.toLowerCase())) await walk(path);
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
export async function readMetaGuid(assetPath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(`${assetPath}.meta`, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    return /guid:\s*([0-9a-f]{32})/.exec(buffer.toString('utf8', 0, bytesRead))?.[1] ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export interface UnityFileContents {
  serialization: 'text' | 'binary' | 'none';
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
  const stream = createReadStream(entry.absPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      reader.push(line);
      if (!reader.wantsMore) break;
    }
  } catch {
    return { serialization: 'none', refs: [], variantOf: null, outline: null };
  } finally {
    lines.close();
    stream.destroy();
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
    const head = buffer.toString('utf8', 0, bytesRead).replace(/^﻿/, '').trimStart();
    return head.startsWith('%YAML') || head.startsWith('{');
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
