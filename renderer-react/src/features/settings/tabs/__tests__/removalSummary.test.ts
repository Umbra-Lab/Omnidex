import { describe, expect, it } from 'vitest';
import { summarizeRemoval } from '../removalSummary';

const none = { assets: 0, favorites: 0, notes: 0, taggedAssets: 0, collectionEntries: 0 };

describe('summarizeRemoval', () => {
  it('says nothing is lost when the folder produced no assets', () => {
    expect(summarizeRemoval(none)).toEqual({ assets: null, curation: null });
  });

  it('names the asset count with exact formatting and singular forms', () => {
    expect(summarizeRemoval({ ...none, assets: 1 })).toEqual({ assets: '1 asset', curation: null });
    expect(summarizeRemoval({ ...none, assets: 2799 }).assets).toBe('2,799 assets');
  });

  it('lists only the kinds of curation that exist, joined in plain English', () => {
    expect(summarizeRemoval({ ...none, assets: 5, notes: 1 }).curation).toBe('1 note');
    expect(summarizeRemoval({ ...none, assets: 5, notes: 2, favorites: 1 }).curation).toBe(
      '2 notes and 1 favorite',
    );
    expect(
      summarizeRemoval({
        assets: 40,
        favorites: 3,
        notes: 12,
        taggedAssets: 1,
        collectionEntries: 8,
      }).curation,
    ).toBe('12 notes, tags on 1 asset, 3 favorites and 8 collection entries');
  });
});
