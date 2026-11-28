import { formatCount } from '@/lib/format';

/** Mirrors `ScanLocationRemovalImpact` from the scan-locations repo. */
export interface RemovalImpact {
  assets: number;
  favorites: number;
  notes: number;
  taggedAssets: number;
  collectionEntries: number;
}

function count(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The phrases for the remove-folder confirm. `assets` is null when the folder
 * has nothing in the library; `curation` is null when none of those assets
 * carries anything the user made.
 */
export function summarizeRemoval(impact: RemovalImpact): {
  assets: string | null;
  curation: string | null;
} {
  if (impact.assets === 0) return { assets: null, curation: null };
  const parts: string[] = [];
  if (impact.notes > 0) parts.push(count(impact.notes, 'note', 'notes'));
  if (impact.taggedAssets > 0)
    parts.push(`tags on ${count(impact.taggedAssets, 'asset', 'assets')}`);
  if (impact.favorites > 0) parts.push(count(impact.favorites, 'favorite', 'favorites'));
  if (impact.collectionEntries > 0) {
    parts.push(count(impact.collectionEntries, 'collection entry', 'collection entries'));
  }
  return {
    assets: count(impact.assets, 'asset', 'assets'),
    curation: parts.length > 0 ? joinList(parts) : null,
  };
}
