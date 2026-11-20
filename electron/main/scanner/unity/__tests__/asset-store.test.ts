import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAssetStoreHeader, readAssetStoreInfo } from '../asset-store';
import { readUnityPackage } from '../unitypackage';
import { STORE_HEADER, samplePackage, withStoreHeader } from './fixtures';

const dirs: string[] = [];
function tempFile(body: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'omnidex-asset-store-'));
  dirs.push(dir);
  const path = join(dir, 'Pack.unitypackage');
  writeFileSync(path, body);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Asset Store header', () => {
  it('reads the store id, title, publisher, category and versions from the gzip header', async () => {
    const info = await readAssetStoreInfo(tempFile(withStoreHeader(samplePackage())));
    expect(info).toEqual({
      id: '102321',
      title: 'POLYGON - Fleet',
      publisher: 'Synty Studios',
      publisherId: '5217',
      category: '3D/Vehicles/Sea',
      version: '1.4.0',
      unityVersion: '2022.3.62f2',
      publishedOn: '07 Oct 2026',
      uploadId: '1014102',
      versionId: '1507792',
    });
  });

  it('leaves the archive readable', async () => {
    const { entries } = await readUnityPackage(tempFile(withStoreHeader(samplePackage())));
    expect(entries).toHaveLength(3);
  });

  it('returns null for a hand-exported package, a plain tar or a broken field', async () => {
    expect(await readAssetStoreInfo(tempFile(samplePackage()))).toBeNull();
    expect(await readAssetStoreInfo(tempFile(gunzipSync(samplePackage())))).toBeNull();
    expect(parseAssetStoreHeader(withStoreHeader(samplePackage(), { title: 'no id' }))).toBeNull();
    const broken = withStoreHeader(samplePackage());
    broken[16] = 0x21; // '{' -> '!': the JSON no longer parses
    expect(parseAssetStoreHeader(broken)).toBeNull();
    expect(parseAssetStoreHeader(Buffer.alloc(4))).toBeNull();
  });

  it('accepts the misspelt "pubbate" key Unity writes in some uploads', () => {
    const { pubdate, ...rest } = STORE_HEADER;
    const info = parseAssetStoreHeader(
      withStoreHeader(samplePackage(), { ...rest, pubbate: pubdate }),
    );
    expect(info?.publishedOn).toBe('07 Oct 2026');
  });
});
