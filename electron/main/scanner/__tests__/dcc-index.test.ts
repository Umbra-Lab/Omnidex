import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb, seedAsset } from '../../db/repos/__tests__/fixtures/test-db';
import { searchAssets } from '../../db/repos/assets';
import { indexDccFiles, scanDccLocation } from '../dcc-index';

describe('DCC catalogue indexing', () => {
  it('indexes path metadata for search and preserves existing Unreal results', () => {
    const db = createTestDb();
    seedAsset(db, { name: 'Unreal Castle', file_path: '/ue/castle', scan_location_id: 1 });
    db.exec(
      readFileSync(resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'), 'utf8'),
    );
    indexDccFiles(db, 2, [
      {
        name: 'Body.blend',
        path: '/dcc/Human/Female/Body.blend',
        relativePath: 'Human/Female/Body.blend',
        kind: 'scene',
        ecosystem: 'blender',
        size: 123,
      },
    ]);
    const search = db.prepare(
      'SELECT a.name FROM assets a JOIN assets_fts f ON f.rowid = a.id WHERE assets_fts MATCH ?',
    );
    expect(search.all('human AND female AND blender')).toEqual([{ name: 'Body.blend' }]);
    expect(search.all('castle')).toEqual([{ name: 'Unreal Castle' }]);
    db.prepare("UPDATE assets SET description = 'curated' WHERE name = 'Body.blend'").run();
    expect(search.all('human AND female AND blender')).toEqual([{ name: 'Body.blend' }]);
    expect(search.all('curated')).toEqual([{ name: 'Body.blend' }]);
    (db as unknown as { close(): void }).close();
  });

  it('rolls back when a path belongs to another location', () => {
    const db = createTestDb();
    db.exec(
      readFileSync(resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'), 'utf8'),
    );
    seedAsset(db, { name: 'Existing', file_path: '/shared/model.fbx', scan_location_id: 1 });
    const files = [
      {
        name: 'New.blend',
        path: '/dcc/New.blend',
        relativePath: 'New.blend',
        kind: 'scene' as const,
        ecosystem: 'blender' as const,
        size: 1,
      },
      {
        name: 'model.fbx',
        path: '/shared/model.fbx',
        relativePath: 'model.fbx',
        kind: 'mesh' as const,
        ecosystem: 'general_3d' as const,
        size: 1,
      },
    ];
    expect(() => indexDccFiles(db, 2, files)).toThrow('another scan location');
    expect(db.prepare('SELECT name FROM assets').all()).toEqual([{ name: 'Existing' }]);
    (db as unknown as { close(): void }).close();
  });

  it('makes explicit woman and man labels searchable as female or male without cross-matching', () => {
    const db = createTestDb();
    db.exec(
      readFileSync(resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'), 'utf8'),
    );
    indexDccFiles(db, 2, [
      {
        name: 'Woman.blend',
        path: '/library/Woman.blend',
        relativePath: 'Woman.blend',
        kind: 'scene',
        ecosystem: 'blender',
        size: 1,
      },
      {
        name: 'Man.blend',
        path: '/library/Man.blend',
        relativePath: 'Man.blend',
        kind: 'scene',
        ecosystem: 'blender',
        size: 1,
      },
    ]);
    expect(searchAssets(db, 'human female blender').map((hit) => hit.name)).toEqual([
      'Woman.blend',
    ]);
    expect(searchAssets(db, 'human male blender').map((hit) => hit.name)).toEqual(['Man.blend']);
    (db as unknown as { close(): void }).close();
  });

  it('leaves existing rows untouched if discovery fails', async () => {
    const db = createTestDb();
    db.exec(
      readFileSync(resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'), 'utf8'),
    );
    seedAsset(db, { name: 'Existing', file_path: '/dcc/existing.blend', scan_location_id: 2 });
    await expect(
      scanDccLocation(db, 2, 'missing-dcc-root', new AbortController().signal),
    ).rejects.toThrow();
    expect(db.prepare('SELECT name FROM assets').all()).toEqual([{ name: 'Existing' }]);
    (db as unknown as { close(): void }).close();
  });

  it.skipIf(!process.env.OMNIDEX_DCC_EXTRA)('indexes bounded real DCC samples', async () => {
    const cases = JSON.parse(process.env.OMNIDEX_DCC_EXTRA as string) as {
      root: string;
      query: string;
      expected: string;
    }[];
    const db = createTestDb();
    db.exec(
      readFileSync(resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'), 'utf8'),
    );
    for (const [index, sample] of cases.entries()) {
      const scan = await scanDccLocation(db, index + 2, sample.root, new AbortController().signal);
      const hits = searchAssets(db, sample.query, 100);
      expect(hits.some((hit) => hit.name === sample.expected)).toBe(true);
      console.log(
        `DCC sample ${sample.expected}: ${scan.total} indexed; ${hits.length} search hits`,
      );
    }
    (db as unknown as { close(): void }).close();
  });
});
