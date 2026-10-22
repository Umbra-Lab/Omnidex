import type { SortOption } from '@omnidex/types/db';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { LayoutGrid, Search, Sparkles, Table2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount } from '@/lib/format';

interface AssetToolbarProps {
  readonly total: number;
  readonly sort: SortOption;
  readonly onSortChange: (next: SortOption) => void;
  readonly view: AssetView;
  readonly onViewChange: (next: AssetView) => void;
  /** How many rows carry marketplace data — gates the enrichment-only sorts. */
  readonly enrichedCount: number;
}

export type AssetView = 'grid' | 'table';

/**
 * Sorts that only mean anything on an enriched row. Ordering 2,799 packs by a
 * field present on 346 of them produces a sequence the user cannot explain, so
 * these are labelled with their real scope rather than offered as if they
 * ranked the whole library.
 */
const ENRICHMENT_SORTS = new Set<SortOption>([
  'rating_desc',
  'rating_asc',
  'reviews_desc',
  'price_desc',
  'price_asc',
]);

const SORT_LABELS: Record<SortOption, string> = {
  name_asc: 'Name A–Z',
  name_desc: 'Name Z–A',
  date_asc: 'Modified (oldest)',
  date_desc: 'Modified (newest)',
  date_added_asc: 'Added (oldest)',
  date_added_desc: 'Added (newest)',
  rating_desc: 'Rating (highest)',
  rating_asc: 'Rating (lowest)',
  reviews_desc: 'Most reviewed',
  price_desc: 'Price (highest)',
  price_asc: 'Price (lowest)',
  size_desc: 'Size (largest)',
  size_asc: 'Size (smallest)',
  favorites_first: 'Favorites first',
};

interface SearchSchema {
  readonly q?: string;
}

export function AssetToolbar({
  total,
  sort,
  onSortChange,
  view,
  onViewChange,
  enrichedCount,
}: AssetToolbarProps) {
  // Mirror the URL `q` param into a local input state so we can debounce.
  // Initial load: pick up whatever was in the URL (e.g. from a deep link).
  const search = useSearch({ strict: false }) as SearchSchema;
  const navigate = useNavigate();
  const [query, setQuery] = useState(search.q ?? '');
  // The grid reads the committed URL `q` (not the typing buffer), so the
  // ordering indicator tracks that: active search → BM25 relevance order.
  const searchActive = (search.q ?? '').trim().length > 0;

  // Push debounced search into the URL so AssetsView's `useSearch` hook
  // re-fires the listCards query. We keep the global `q` shape so the
  // filter contract doesn't fork from the rest of the app.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = query.trim();
      const current = search.q ?? '';
      if (next === current) return;
      void navigate({
        to: '/assets',
        search: (prev) => ({ ...prev, q: next || undefined }),
      });
    }, 200);
    return () => clearTimeout(t);
  }, [query, search.q, navigate]);

  // Show the result-count inside the placeholder so the toolbar reads as one
  // primary action. When the user types, the placeholder disappears and the
  // count moves to the right edge as a small badge instead.
  const placeholder = `Search ${formatCount(total)} assets…`;

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-surface-800/60 bg-surface-950/60 px-3">
      <div className="relative max-w-2xl flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-surface-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="h-8 border-surface-700/80 bg-surface-900/80 pl-9 pr-20 cap-14 text-surface-100 placeholder:text-surface-400 focus-visible:border-accent-500/60 focus-visible:ring-1 focus-visible:ring-accent-500/40"
          aria-label="Search assets"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-surface-400 hover:bg-surface-800 hover:text-surface-100"
          >
            <X size={12} />
          </button>
        ) : (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono cap-10 uppercase tracking-[0.18em] text-surface-400">
            {formatCount(total)}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {searchActive ? (
          // FTS search ranks by BM25 relevance, which overrides the sort options.
          // Surface a static indicator so the ordering isn't a silent surprise;
          // the sort dropdown returns (with its prior value) once search clears.
          <div
            className="flex h-8 w-[180px] items-center gap-1.5 rounded-md border border-surface-800 px-3 cap-12 text-surface-400"
            title="Search results are ranked by relevance"
          >
            <Sparkles size={12} />
            Relevance
          </div>
        ) : (
          <Select value={sort} onValueChange={(v) => onSortChange(v as SortOption)}>
            <SelectTrigger className="h-8 w-[180px] cap-12">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORT_LABELS).map(([value, label]) => {
                const scoped = ENRICHMENT_SORTS.has(value as SortOption);
                return (
                  <SelectItem key={value} value={value}>
                    {label}
                    {scoped ? (
                      <span className="ml-2 font-mono cap-10 text-surface-400">
                        {formatCount(enrichedCount)} matched
                      </span>
                    ) : null}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
        {/* Two named views, not two unlabeled 12px glyphs. The old control
            was a density stepper whose icons implied grid-vs-list while only
            changing the column count — the source comment apologised for the
            metaphor. What a 3,000-item library actually needs is a table, and
            column width is a table concern, not a preference. */}
        <div className="flex items-center overflow-hidden rounded-md border border-surface-700">
          <button
            type="button"
            onClick={() => onViewChange('grid')}
            aria-pressed={view === 'grid'}
            className={viewButtonClass(view === 'grid')}
          >
            <LayoutGrid size={13} />
            Grid
          </button>
          <button
            type="button"
            onClick={() => onViewChange('table')}
            aria-pressed={view === 'table'}
            className={viewButtonClass(view === 'table')}
          >
            <Table2 size={13} />
            Table
          </button>
        </div>
      </div>
    </div>
  );
}

function viewButtonClass(active: boolean): string {
  return [
    'flex h-[30px] items-center gap-1.5 px-3 cap-12 font-medium transition-colors',
    active ? 'bg-surface-800 text-surface-50' : 'text-surface-300 hover:text-surface-100',
  ].join(' ');
}
