import { formatCount } from '@/lib/format';

/** Mirrors `ScanLocationRemovalImpact` from the scan-locations repo. */
export interface RemovalImpact {
  assets: number;
  favorites: number;
  notes: number;
  taggedAssets: number;
  collectionEntries: number;
  lessonsWithProgress: number;
  matchDecisions: number;
}

/**
 * One counted thing: `before` + `count` + ' ' + `label`. The count stays
 * separate so the dialog can set only the number in mono (DESIGN.md).
 */
export interface CountPhrase {
  before: string;
  count: string;
  label: string;
}

function phrase(n: number, one: string, many: string, before = ''): CountPhrase {
  return { before, count: formatCount(n), label: n === 1 ? one : many };
}

/** Separator to print before phrase `index` of `total`: "", ", " or " and ". */
export function separatorBefore(index: number, total: number): string {
  if (index === 0) return '';
  return index === total - 1 ? ' and ' : ', ';
}

/**
 * The phrases for the remove-folder confirm. `assets` is null when the folder
 * has nothing in the library; `curation` lists only what the user made that
 * the removal deletes.
 */
export function summarizeRemoval(impact: RemovalImpact): {
  assets: CountPhrase | null;
  curation: CountPhrase[];
} {
  if (impact.assets === 0) return { assets: null, curation: [] };
  const curation: CountPhrase[] = [];
  if (impact.notes > 0) curation.push(phrase(impact.notes, 'note', 'notes'));
  if (impact.taggedAssets > 0) {
    curation.push(phrase(impact.taggedAssets, 'asset', 'assets', 'tags on '));
  }
  if (impact.favorites > 0) curation.push(phrase(impact.favorites, 'favorite', 'favorites'));
  if (impact.collectionEntries > 0) {
    curation.push(phrase(impact.collectionEntries, 'collection entry', 'collection entries'));
  }
  if (impact.lessonsWithProgress > 0) {
    curation.push(phrase(impact.lessonsWithProgress, 'lesson', 'lessons', 'watch progress on '));
  }
  if (impact.matchDecisions > 0) {
    curation.push(phrase(impact.matchDecisions, 'match decision', 'match decisions'));
  }
  return { assets: phrase(impact.assets, 'asset', 'assets'), curation };
}
