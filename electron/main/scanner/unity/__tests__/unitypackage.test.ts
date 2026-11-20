import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { readUnityPackage } from '../unitypackage';
import { GUID, samplePackage, tar } from './fixtures';

const dirs: string[] = [];
function tempFile(body: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'omnidex-unitypackage-'));
  dirs.push(dir);
  const path = join(dir, 'Pack.unitypackage');
  writeFileSync(path, body);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('.unitypackage reader', () => {
  it('lists files by path and GUID, reads text assets, keeps the prefab preview', async () => {
    const { entries, preview } = await readUnityPackage(tempFile(samplePackage()));
    expect(entries.map((e) => [e.relPath, e.kind, e.serialization])).toEqual([
      ['Assets/PolygonFleet/Materials/Hull.mat', 'material', 'text'],
      ['Assets/PolygonFleet/Prefabs/SM_Ship_01.prefab', 'prefab', 'text'],
      ['Assets/PolygonFleet/Textures/Hull.png', 'texture', 'none'],
    ]);
    const ship = entries.find((e) => e.guid === GUID.ship);
    expect(ship?.refs.sort()).toEqual([GUID.hull, GUID.script].sort());
    expect(ship?.outline?.roots[0].name).toBe('Ship');
    expect(entries.find((e) => e.guid === GUID.albedo)?.size).toBe(2000);
    expect(preview?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('follows GNU long names and pax paths', async () => {
    const long = `${GUID.hull}/pathname`;
    const pax = `27 path=${GUID.hull}/asset\n`;
    const body = gzipSync(
      tar([
        { name: '././@LongLink', body: `${long}\0`, type: 'L' },
        { name: 'ignored', body: 'Assets/Deep/Hull.mat' },
        { name: 'PaxHeader', body: pax, type: 'x' },
        { name: 'ignored-too', body: '%YAML 1.1\nguid: a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2\n' },
      ]),
    );
    const { entries } = await readUnityPackage(tempFile(body));
    expect(entries).toHaveLength(1);
    expect(entries[0].relPath).toBe('Assets/Deep/Hull.mat');
    expect(entries[0].refs).toEqual(['a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2']);
  });

  it('rejects a file that is not gzip', async () => {
    await expect(readUnityPackage(tempFile(Buffer.from('nope')))).rejects.toThrow();
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readUnityPackage(tempFile(samplePackage()), controller.signal)).rejects.toThrow();
  });
});
