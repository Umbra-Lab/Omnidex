import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedAsset } from '../../db/repos/__tests__/fixtures/test-db';
import { searchAssets } from '../../db/repos/assets';
import { ASSET_UPSERT_SQL } from '../asset-upsert';
import { backfillPackSearchText, buildSearchText } from '../search-text';

describe('buildSearchText', () => {
  it('splits camelCase and keeps neighbouring pieces joined', () => {
    expect(buildSearchText(['ModularSciFiCorridor'])).toBe(
      'Modular Sci Fi Corridor ModularSci SciFi FiCorridor',
    );
  });

  it('splits acronyms, digits and punctuation', () => {
    expect(buildSearchText(['UIKit'])).toBe('UI Kit UIKit');
    expect(buildSearchText(['UE5Pack_v2'])).toBe('UE5 Pack UE5Pack v2');
    expect(buildSearchText(['com.unity.textmeshpro'])).toBe('com unity textmeshpro');
  });

  it('skips empty parts', () => {
    expect(buildSearchText([null, 'Water', undefined, ''])).toBe('Water');
  });
});

describe('Unreal pack names in search', () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
    db.exec(
      readFileSync(resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'), 'utf8'),
    );
  });

  const upsert = (name: string, path: string) => {
    const now = new Date().toISOString();
    db.prepare(ASSET_UPSERT_SQL).run(
      name,
      path,
      'unreal_pack',
      1,
      0,
      now,
      now,
      1,
      'unreal_engine',
      'unreal_engine',
      null,
      buildSearchText([name]),
    );
  };

  it('finds a camelCase pack by a word inside its name', () => {
    upsert('ModularSciFiCorridor', '/packs/ModularSciFiCorridor');
    expect(searchAssets(db, 'corridor').map((a) => a.name)).toEqual(['ModularSciFiCorridor']);
    expect(searchAssets(db, 'scifi').map((a) => a.name)).toEqual(['ModularSciFiCorridor']);
  });

  it('backfills rows scanned before the column was written, once', () => {
    seedAsset(db, { name: 'StylizedWaterShader', file_path: '/packs/a' });
    seedAsset(db, { name: 'Body.blend', file_path: '/dcc/b', asset_type: 'dcc_scene' });
    expect(searchAssets(db, 'water')).toEqual([]);

    expect(backfillPackSearchText(db)).toBe(1);
    expect(searchAssets(db, 'water').map((a) => a.name)).toEqual(['StylizedWaterShader']);
    // DCC rows own their text; the backfill leaves them alone.
    const dcc = db.prepare("SELECT scan_search_text FROM assets WHERE file_path = '/dcc/b'").get();
    expect(dcc).toEqual({ scan_search_text: null });
    expect(backfillPackSearchText(db)).toBe(0);
  });
});
