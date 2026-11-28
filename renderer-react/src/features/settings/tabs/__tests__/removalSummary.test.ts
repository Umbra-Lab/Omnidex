import { describe, expect, it } from 'vitest';
import { type CountPhrase, separatorBefore, summarizeRemoval } from '../removalSummary';

const none = {
  assets: 0,
  favorites: 0,
  notes: 0,
  taggedAssets: 0,
  collectionEntries: 0,
  lessonsWithProgress: 0,
  matchDecisions: 0,
};

/** Render phrases the way the dialog does, as plain text. */
function text(phrases: readonly CountPhrase[]): string {
  return phrases
    .map((p, i) => `${separatorBefore(i, phrases.length)}${p.before}${p.count} ${p.label}`)
    .join('');
}

describe('summarizeRemoval', () => {
  it('says nothing is lost when the folder produced no assets', () => {
    expect(summarizeRemoval(none)).toEqual({ assets: null, curation: [] });
  });

  it('keeps the number apart from its label so only the number is mono', () => {
    expect(summarizeRemoval({ ...none, assets: 1 }).assets).toEqual({
      before: '',
      count: '1',
      label: 'asset',
    });
    expect(summarizeRemoval({ ...none, assets: 2799 }).assets).toEqual({
      before: '',
      count: '2,799',
      label: 'assets',
    });
  });

  it('lists only the kinds of curation that exist, joined in plain English', () => {
    expect(text(summarizeRemoval({ ...none, assets: 5, notes: 1 }).curation)).toBe('1 note');
    expect(text(summarizeRemoval({ ...none, assets: 5, notes: 2, favorites: 1 }).curation)).toBe(
      '2 notes and 1 favorite',
    );
    expect(
      text(
        summarizeRemoval({
          assets: 40,
          favorites: 3,
          notes: 12,
          taggedAssets: 1,
          collectionEntries: 8,
          lessonsWithProgress: 2,
          matchDecisions: 1,
        }).curation,
      ),
    ).toBe(
      '12 notes, tags on 1 asset, 3 favorites, 8 collection entries, ' +
        'watch progress on 2 lessons and 1 match decision',
    );
  });
});
