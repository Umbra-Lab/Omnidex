import { open } from 'node:fs/promises';

/**
 * What the Unity Asset Store says about a `.unitypackage` it served, read from the file.
 *
 * Asset Store downloads are gzip files whose header carries a JSON blob in the optional
 * "extra" field (RFC 1952, FLG.FEXTRA): the store's product id, title, publisher,
 * category, package version, the Unity version it was uploaded from and the publish
 * date. Reading it costs one small read and no network, and the id is exact, so no
 * name matching is involved. Packages exported from an Editor by hand have no such
 * field and return null.
 */
export interface AssetStoreInfo {
  id: string;
  title: string | null;
  publisher: string | null;
  publisherId: string | null;
  category: string | null;
  version: string | null;
  unityVersion: string | null;
  publishedOn: string | null;
  uploadId: string | null;
  versionId: string | null;
}

/** The gzip header is 10 bytes, then a 2-byte length; the field itself is at most 64 KB. */
const HEAD_BYTES = 12 + 0xffff;
const FEXTRA = 0x04;

export async function readAssetStoreInfo(path: string): Promise<AssetStoreInfo | null> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    return parseAssetStoreHeader(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function parseAssetStoreHeader(head: Buffer): AssetStoreInfo | null {
  if (head.length < 12 || head[0] !== 0x1f || head[1] !== 0x8b) return null;
  if ((head[3] & FEXTRA) === 0) return null;
  const length = head.readUInt16LE(10);
  const extra = head.subarray(12, 12 + length);
  // The field is split into subfields (2-byte id, 2-byte length); Unity writes one whose
  // payload is the JSON. Walk them rather than trusting a fixed offset.
  for (let at = 0; at + 4 <= extra.length; ) {
    const size = extra.readUInt16LE(at + 2);
    const payload = extra.subarray(at + 4, at + 4 + size);
    const info = fromJson(payload);
    if (info) return info;
    at += 4 + size;
  }
  return null;
}

function fromJson(payload: Buffer): AssetStoreInfo | null {
  const start = payload.indexOf(0x7b); // '{'
  if (start === -1) return null;
  let data: unknown;
  try {
    data = JSON.parse(payload.subarray(start).toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const link = record.link as Record<string, unknown> | undefined;
  const id = text(link?.id) ?? text(record.id);
  if (!id || !/^\d+$/.test(id)) return null;
  const publisher = record.publisher as Record<string, unknown> | undefined;
  const category = record.category as Record<string, unknown> | undefined;
  return {
    id,
    title: text(record.title),
    publisher: text(publisher?.label),
    publisherId: text(publisher?.id),
    category: text(category?.label),
    version: text(record.version),
    unityVersion: text(record.unity_version),
    // Unity has shipped this key misspelt ("pubbate") in some uploads.
    publishedOn: text(record.pubdate) ?? text(record.pubbate),
    uploadId: text(record.upload_id),
    versionId: text(record.version_id),
  };
}

function text(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
