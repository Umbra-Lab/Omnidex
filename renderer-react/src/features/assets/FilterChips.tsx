import { X } from 'lucide-react';
import type { Facet } from '@/features/assets/facets';

interface FilterChipsProps {
  readonly facets: readonly Facet[];
  readonly onRemove: (key: string) => void;
  readonly onClear: () => void;
}

/**
 * The active filter, stated in words.
 *
 * Facets used to be legible only as highlighted rows in a 240px sidebar, which
 * is fine for one and useless for four — and an intersection narrow enough to
 * return nothing reads as a broken library rather than a filter the user
 * applied three clicks ago. Each chip names one facet and removes it; "Clear
 * all" drops the lot.
 *
 * Renders nothing when there is no filter, so the toolbar keeps its height in
 * the common case instead of reserving an empty strip.
 */
export function FilterChips({ facets, onRemove, onClear }: FilterChipsProps) {
  if (facets.length === 0) return null;
  return (
    // A fieldset because that is literally "a group of related controls" — no
    // form required — and it gives the chips one accessible name instead of a
    // screen reader meeting eight unexplained buttons.
    <fieldset
      aria-label="Active filters"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-surface-800/60 bg-surface-950/40 px-3 py-1.5"
    >
      {/* Says the same thing as the fieldset's label, so it is decoration. */}
      <span
        aria-hidden="true"
        className="font-mono cap-9 font-semibold uppercase tracking-[0.16em] text-surface-400"
      >
        Filtered by
      </span>
      {facets.map((facet) => (
        <button
          key={facet.key}
          type="button"
          onClick={() => onRemove(facet.key)}
          aria-label={`Remove filter ${facet.label}`}
          className="group flex h-6 items-center gap-1.5 rounded-sm border border-surface-700 bg-surface-900 pl-2 pr-1.5 cap-12 text-surface-200 transition-colors [transition-duration:var(--duration-micro)] hover:border-surface-600 hover:bg-surface-800 hover:text-surface-50"
        >
          {facet.label}
          <X size={11} className="text-surface-400 group-hover:text-surface-100" />
        </button>
      ))}
      {/* Only worth its own control once removing them one at a time is a chore. */}
      {facets.length > 1 ? (
        <button
          type="button"
          onClick={onClear}
          className="ml-1 h-6 rounded-sm px-1.5 font-mono cap-10 uppercase tracking-[0.14em] text-surface-400 transition-colors hover:bg-surface-900 hover:text-surface-200"
        >
          Clear all
        </button>
      ) : null}
    </fieldset>
  );
}
