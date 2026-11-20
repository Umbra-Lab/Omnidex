import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { createGunzip } from 'node:zlib';
import { isReferencingKind, type UnityAssetKind, unityKindOf, wantsOutline } from './kinds';
import { readUnityYamlText, type UnityOutline, type UnityYamlResult } from './yaml';

/**
 * Read a `.unitypackage` in place. The file is a tar, usually gzip'd but sometimes stored
 * uncompressed (Unity opens both), with one folder per asset, named by the asset's GUID:
 *
 *   <guid>/pathname     the asset's path in the project, e.g. Assets/Synty/Ship.prefab
 *   <guid>/asset        the file itself (absent for folders)
 *   <guid>/asset.meta   its .meta
 *   <guid>/preview.png  an optional thumbnail Unity rendered when the package was made
 *
 * The archive is streamed once and nothing is extracted to disk. A small text asset
 * (scene, prefab, material) is held in memory only while its references are read, as
 * soon as its body arrives; previews are kept up to a fixed budget so one can become the
 * thumbnail.
 */

/** Text assets larger than this are not read for references (the size is still recorded). */
const MAX_TEXT_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_PREVIEW_TOTAL = 8 * 1024 * 1024;

export interface UnityPackageEntry {
  guid: string;
  relPath: string;
  name: string;
  kind: UnityAssetKind;
  size: number;
  serialization: 'text' | 'binary' | 'none';
  refs: string[];
  variantOf: string | null;
  outline: UnityOutline | null;
}

export interface UnityPackageContents {
  entries: UnityPackageEntry[];
  /** The best preview image found, preferring prefabs, then models, then materials. */
  preview: Buffer | null;
}

interface Pending {
  pathname?: string;
  size?: number;
  hasAsset: boolean;
  /** Read as soon as the body arrived, before the pathname (and so the kind) may be known. */
  parsed?: UnityYamlResult;
  preview?: Buffer;
}

const PREVIEW_PRIORITY: UnityAssetKind[] = ['prefab', 'prefab_variant', 'model', 'material'];

export async function readUnityPackage(
  path: string,
  signal?: AbortSignal,
): Promise<UnityPackageContents> {
  const byGuid = new Map<string, Pending>();
  let previewBytes = 0;
  const pending = (guid: string): Pending => {
    let item = byGuid.get(guid);
    if (!item) {
      item = { hasAsset: false };
      byGuid.set(guid, item);
    }
    return item;
  };

  const gzipped = await isGzip(path);
  const source = createReadStream(path);
  const gunzip = gzipped ? createGunzip() : null;
  // pipe() does not forward a read error (a locked or vanished file); without this it
  // would surface as an uncaught exception instead of rejecting this promise.
  if (gunzip) {
    source.on('error', (error) => gunzip.destroy(error));
    source.pipe(gunzip);
  }
  try {
    await walkTar(gunzip ?? source, signal, (name, size) => {
      const match = /^(?:\.\/)?([0-9a-f]{32})\/(pathname|asset|preview\.png)$/.exec(name);
      if (!match) return null;
      const [, guid, part] = match;
      const item = pending(guid);
      if (part === 'asset') {
        item.hasAsset = true;
        item.size = size;
        if (size > MAX_TEXT_ASSET_BYTES) return null;
        return (body) => {
          const head = body
            .subarray(0, 64)
            .toString('utf8')
            .replace(/^\uFEFF/, '')
            .trimStart();
          if (!head.startsWith('%YAML') && !head.startsWith('{')) return;
          // The kind is not known yet, so read as a prefab with an outline and trim later.
          item.parsed = readUnityYamlText(body.toString('utf8'), {
            outline: true,
            prefab: true,
            selfGuid: guid,
          });
        };
      }
      if (part === 'pathname') {
        return (body) => {
          // Unity writes the path on the first line, sometimes followed by a "00" line.
          item.pathname = body.toString('utf8').split(/\r?\n/)[0].trim();
        };
      }
      if (size > MAX_PREVIEW_BYTES || previewBytes + size > MAX_PREVIEW_TOTAL) return null;
      return (body) => {
        previewBytes += body.length;
        item.preview = Buffer.from(body);
      };
    });
  } finally {
    source.destroy();
    gunzip?.destroy();
  }

  const entries: UnityPackageEntry[] = [];
  let preview: Buffer | null = null;
  let previewRank = Number.POSITIVE_INFINITY;
  for (const [guid, item] of byGuid) {
    if (!item.pathname || !item.hasAsset) continue; // folders have no asset
    let kind = unityKindOf(item.pathname);
    let serialization: UnityPackageEntry['serialization'] = 'none';
    let refs: string[] = [];
    let variantOf: string | null = null;
    let outline: UnityOutline | null = null;
    if (isReferencingKind(kind)) {
      if (item.parsed) {
        serialization = item.parsed.serialization;
        refs = [...item.parsed.refs];
        variantOf = kind === 'prefab' ? item.parsed.variantOf : null;
        outline = wantsOutline(kind) ? item.parsed.outline : null;
      } else if ((item.size ?? 0) <= MAX_TEXT_ASSET_BYTES) {
        serialization = 'binary';
      }
    }
    if (kind === 'prefab' && variantOf) kind = 'prefab_variant';
    item.parsed = undefined;
    entries.push({
      guid,
      relPath: item.pathname,
      name: basename(item.pathname),
      kind,
      size: item.size ?? 0,
      serialization,
      refs,
      variantOf,
      outline,
    });
    if (item.preview) {
      const rank = PREVIEW_PRIORITY.indexOf(kind);
      const effective = rank === -1 ? PREVIEW_PRIORITY.length : rank;
      if (effective < previewRank) {
        previewRank = effective;
        preview = item.preview;
      }
    }
  }
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { entries, preview };
}

type BodySink = ((body: Buffer) => void) | null;

/**
 * Minimal streaming tar reader (ustar, GNU long names, pax `path`). For each entry,
 * `onEntry` decides whether its body is wanted; unwanted bodies are skipped without
 * being buffered.
 */
/** True when the file starts with the gzip signature (1f 8b). */
async function isGzip(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const magic = Buffer.alloc(2);
    const { bytesRead } = await handle.read(magic, 0, 2, 0);
    return bytesRead === 2 && magic[0] === 0x1f && magic[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

export async function walkTar(
  stream: AsyncIterable<Buffer>,
  signal: AbortSignal | undefined,
  onEntry: (name: string, size: number) => BodySink,
): Promise<void> {
  let buffer: Buffer = Buffer.alloc(0);
  let state: 'header' | 'body' = 'header';
  let remaining = 0;
  let padding = 0;
  let sink: BodySink = null;
  let chunks: Buffer[] = [];
  let longName: string | null = null;
  let paxSize: number | null = null;
  let special: 'longname' | 'pax' | null = null;

  const finishBody = () => {
    const body = Buffer.concat(chunks);
    chunks = [];
    if (special === 'longname') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (special === 'pax') {
      const records = body.toString('utf8');
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(records)?.[1];
      if (path) longName = path;
      const size = /(?:^|\n)\d+ size=(\d+)\n/.exec(records)?.[1];
      if (size) paxSize = Number(size);
    } else sink?.(body);
    special = null;
    sink = null;
  };

  for await (const chunk of stream) {
    signal?.throwIfAborted();
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (true) {
      if (state === 'header') {
        if (padding > 0) {
          const skip = Math.min(padding, buffer.length);
          buffer = buffer.subarray(skip);
          padding -= skip;
          if (padding > 0) break;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) continue; // end-of-archive blocks
        if (!checksumOk(header)) throw new Error('Corrupt tar header in .unitypackage');
        let size = parseSize(header.subarray(124, 136));
        const type = String.fromCharCode(header[156] || 48);
        // POSIX ustar only: old GNU tar ("ustar  ") keeps timestamps where the prefix would be.
        const ustarPrefix = header.subarray(257, 263).toString('latin1') === 'ustar\0';
        let name = cString(header.subarray(0, 100));
        if (ustarPrefix) {
          const prefix = cString(header.subarray(345, 500));
          if (prefix) name = `${prefix}/${name}`;
        }
        if (longName !== null) {
          name = longName;
          longName = null;
        }
        if (paxSize !== null && type !== 'x' && type !== 'L') {
          size = paxSize;
          paxSize = null;
        }
        if (type === 'L') {
          special = 'longname';
          sink = null;
        } else if (type === 'x') {
          special = 'pax';
          sink = null;
        } else if (type === '0' || type === '\0' || type === '7') {
          sink = onEntry(name, size);
        } else sink = null;
        remaining = size;
        padding = (512 - (size % 512)) % 512;
        state = 'body';
        if (remaining === 0) {
          finishBody();
          state = 'header';
        }
        continue;
      }
      const take = Math.min(remaining, buffer.length);
      if (take === 0) break;
      if (sink || special) chunks.push(Buffer.from(buffer.subarray(0, take)));
      buffer = buffer.subarray(take);
      remaining -= take;
      if (remaining > 0) break;
      finishBody();
      state = 'header';
    }
  }
  // gunzip reports a cut-off gzip stream itself; a plain tar has to be checked here.
  if (remaining > 0 || buffer.some((byte) => byte !== 0)) {
    throw new Error('Truncated .unitypackage');
  }
}

function cString(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes.toString('utf8', 0, end === -1 ? bytes.length : end);
}

function parseSize(field: Buffer): number {
  if (field[0] & 0x80) {
    // GNU base-256 for entries over 8 GB.
    let value = 0;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i];
    return value;
  }
  const text = cString(field).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

/** Header checksum: the sum of all bytes with the checksum field read as spaces. */
function checksumOk(header: Buffer): boolean {
  const stored = Number.parseInt(cString(header.subarray(148, 156)).trim(), 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
  return sum === stored;
}
