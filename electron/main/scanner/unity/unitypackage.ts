import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { createGunzip } from 'node:zlib';
import { isReferencingKind, type UnityAssetKind, unityKindOf, wantsOutline } from './kinds';
import { readUnityYamlText, type UnityOutline } from './yaml';

/**
 * Read a `.unitypackage` in place. The file is a gzip'd tar with one folder per asset,
 * named by the asset's GUID:
 *
 *   <guid>/pathname     the asset's path in the project, e.g. Assets/Synty/Ship.prefab
 *   <guid>/asset        the file itself (absent for folders)
 *   <guid>/asset.meta   its .meta
 *   <guid>/preview.png  an optional thumbnail Unity rendered when the package was made
 *
 * The archive is streamed once and nothing is extracted to disk. Only small text assets
 * (scenes, prefabs, materials) are held in memory, one at a time, to read their GUID
 * references; previews are kept up to a fixed budget so one can become the thumbnail.
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
  text?: string;
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

  await walkTar(createReadStream(path).pipe(createGunzip()), signal, (name, size) => {
    const match = /^(?:\.\/)?([0-9a-f]{32})\/(pathname|asset|preview\.png)$/.exec(name);
    if (!match) return null;
    const [, guid, part] = match;
    const item = pending(guid);
    if (part === 'asset') {
      item.hasAsset = true;
      item.size = size;
      if (size > MAX_TEXT_ASSET_BYTES) return null;
      return (body) => {
        const head = body.subarray(0, 64).toString('utf8').replace(/^﻿/, '').trimStart();
        if (head.startsWith('%YAML') || head.startsWith('{')) item.text = body.toString('utf8');
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
      if (item.text !== undefined) {
        const result = readUnityYamlText(item.text, {
          outline: wantsOutline(kind),
          prefab: kind === 'prefab',
          selfGuid: guid,
        });
        serialization = result.serialization;
        refs = [...result.refs];
        variantOf = result.variantOf;
        outline = result.outline;
      } else if ((item.size ?? 0) <= MAX_TEXT_ASSET_BYTES) {
        serialization = 'binary';
      }
    }
    if (kind === 'prefab' && variantOf) kind = 'prefab_variant';
    item.text = undefined;
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
  let special: 'longname' | 'pax' | null = null;

  const finishBody = () => {
    const body = Buffer.concat(chunks);
    chunks = [];
    if (special === 'longname') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (special === 'pax') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1];
      if (path) longName = path;
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
        const size = parseSize(header.subarray(124, 136));
        const type = String.fromCharCode(header[156] || 48);
        const ustarPrefix = header.subarray(257, 262).toString('latin1') === 'ustar';
        let name = cString(header.subarray(0, 100));
        if (ustarPrefix) {
          const prefix = cString(header.subarray(345, 500));
          if (prefix) name = `${prefix}/${name}`;
        }
        if (longName !== null) {
          name = longName;
          longName = null;
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
