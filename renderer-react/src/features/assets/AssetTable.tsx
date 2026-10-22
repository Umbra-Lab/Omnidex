import { useVirtualizer } from '@tanstack/react-virtual';
import { Check } from 'lucide-react';
import { useRef } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { formatBytes, formatTaxonomyLabel } from '@/lib/format';
import type { AssetCardShape } from './AssetCard';
import type { SelectModifiers } from './useAssetSelection';

/**
 * The table view.
 *
 * 88% of this library has no thumbnail, and the grid answers that by giving
 * 68% of every card to a 16:9 well that renders a grey gradient and an icon.
 * Six columns of that is a wall of noise carrying one line of information —
 * the filename you already knew. Text belongs in a table.
 *
 * Same virtualizer, same selection model, same row identity as the grid. Only
 * the presentation differs, so switching views never changes what is selected.
 */

const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 34;

/** Ecosystem hue, mirroring the sidebar so the mark means the same thing. */
const ECO_MARKS: Readonly<Record<string, string>> = {
  unreal_engine: 'bg-eco-unreal',
  blender: 'bg-eco-blender',
  agnostic: 'bg-eco-agnostic',
  unknown: 'bg-eco-unclassified',
};

/**
 * Column template shared by the header and every row. One constant so the two
 * cannot drift — a header that does not line up with its body is the single
 * most common table bug.
 */
const COLUMNS = '36px minmax(200px,1fr) 110px 140px 88px 84px 150px 78px 104px';

/**
 * The fixed columns plus gaps come to ~900px. Below that the table scrolls
 * horizontally rather than crushing Name to nothing — `minmax(0,1fr)` happily
 * collapses a column to zero width, which is how the name column vanished
 * entirely at 1,030px of available space.
 */
const MIN_TABLE_WIDTH = 940;

interface AssetTableProps {
  readonly assets: ReadonlyArray<AssetCardShape>;
  readonly isLoading?: boolean;
  readonly selectedIds?: ReadonlySet<number>;
  readonly activeId?: number | null;
  readonly onSelect?: (id: number, modifiers: SelectModifiers) => void;
  readonly onContextMenu?: (asset: AssetCardShape) => (event: React.MouseEvent) => void;
  /** Names by scan-location id, so the Source column reads as a place. */
  readonly locationNames?: ReadonlyMap<number, string>;
  readonly allSelected?: boolean;
  readonly onToggleAll?: () => void;
}

export function AssetTable({
  assets,
  isLoading,
  selectedIds,
  activeId,
  onSelect,
  onContextMenu,
  locationNames,
  allSelected,
  onToggleAll,
}: AssetTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: assets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  if (isLoading && assets.length === 0) {
    return (
      <div className="flex h-full flex-col overflow-auto">
        <div style={{ minWidth: MIN_TABLE_WIDTH }}>
          <TableHeader allSelected={false} />
        </div>
        <div className="flex flex-col gap-px p-2">
          {Array.from({ length: 12 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
            <Skeleton key={i} className="w-full" style={{ height: ROW_HEIGHT - 4 }} />
          ))}
        </div>
      </div>
    );
  }

  if (!isLoading && assets.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-surface-400">
        <div className="cap-14">No assets found.</div>
        <div className="font-mono cap-11">Add a scan location to start indexing.</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* The header lives INSIDE the scroll container, sticky. Outside it, its
          fixed grid columns set a min-content width on the whole section,
          which pushed the inspector off the right edge of the window — and
          the header stopped lining up with the body the moment you scrolled
          sideways. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: MIN_TABLE_WIDTH }}>
          <TableHeader allSelected={allSelected ?? false} onToggleAll={onToggleAll} />
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const asset = assets[row.index];
              if (!asset) return null;
              return (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  top={row.start}
                  selected={selectedIds?.has(asset.id) ?? false}
                  active={activeId === asset.id}
                  onSelect={onSelect}
                  {...(onContextMenu ? { onContextMenu: onContextMenu(asset) } : {})}
                  {...(locationNames ? { locationNames } : {})}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function TableHeader({
  allSelected,
  onToggleAll,
}: {
  readonly allSelected: boolean;
  readonly onToggleAll?: () => void;
}) {
  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: COLUMNS, height: HEADER_HEIGHT }}
      // NO cap-* class on this element. Capsize classes trim leading via
      // ::before/::after, and a grid container's pseudo-elements are
      // themselves grid items — so `cap-11` here silently occupied column 1,
      // shoved every label one column right, and wrapped "Match" onto a second
      // row. Cap classes go on the cells, never on the grid itself.
      className="sticky top-0 z-10 items-center gap-3 border-b border-surface-700 bg-surface-900 px-4 font-mono uppercase tracking-[0.14em] text-surface-400"
    >
      <button
        type="button"
        onClick={onToggleAll}
        aria-label={allSelected ? 'Deselect all' : 'Select all'}
        className={cn(
          'flex size-4 items-center justify-center rounded-md border transition-colors',
          allSelected
            ? 'border-accent-500 bg-accent-500 text-accent-on'
            : 'border-surface-500 text-transparent hover:border-surface-300',
        )}
      >
        <Check size={11} strokeWidth={3} />
      </button>
      <span className="cap-11">Name</span>
      <span className="cap-11">Kind</span>
      <span className="cap-11">Ecosystem</span>
      <span className="cap-11">Engine</span>
      <span className="cap-11 text-right">Size</span>
      <span className="cap-11">Source</span>
      <span className="cap-11">Added</span>
      <span className="cap-11">Match</span>
    </div>
  );
}

function AssetRow({
  asset,
  top,
  selected,
  active,
  onSelect,
  onContextMenu,
  locationNames,
}: {
  readonly asset: AssetCardShape;
  readonly top: number;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onSelect?: (id: number, modifiers: SelectModifiers) => void;
  readonly onContextMenu?: (event: React.MouseEvent) => void;
  readonly locationNames?: ReadonlyMap<number, string>;
}) {
  const ecoKey = (asset.asset_ecosystem ?? asset.ecosystem ?? 'unknown').toLowerCase();
  const matched = asset.matched_orbital_product_slug != null;
  const source =
    asset.scan_location_id === -1
      ? 'FAB vault'
      : asset.scan_location_id != null
        ? (locationNames?.get(asset.scan_location_id) ?? '—')
        : '—';

  return (
    // biome-ignore lint/a11y/useSemanticElements: a real <button> cannot contain the row's own checkbox button (invalid HTML); role+keydown is the supported pattern
    <div
      role="button"
      tabIndex={0}
      data-testid="asset-row"
      data-asset-id={asset.id}
      aria-pressed={selected}
      onClick={(e) => onSelect?.(asset.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(asset.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
        }
      }}
      onContextMenu={onContextMenu}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: ROW_HEIGHT,
        transform: `translateY(${top}px)`,
        display: 'grid',
        gridTemplateColumns: COLUMNS,
      }}
      className={cn(
        // select-none for the same reason the card needs it: shift-click means
        // "extend range" to us and "extend text selection" to the browser.
        'cursor-pointer select-none items-center gap-3 border-b border-surface-800/50 px-4 text-left outline-none',
        selected ? 'bg-accent-500/10' : 'hover:bg-surface-900/60',
        active ? 'shadow-[inset_2px_0_0_0_var(--color-accent-500)]' : '',
      )}
    >
      <span
        className={cn(
          'flex size-4 items-center justify-center rounded-md border',
          selected
            ? 'border-accent-500 bg-accent-500 text-accent-on'
            : 'border-surface-600 text-transparent',
        )}
      >
        <Check size={11} strokeWidth={3} />
      </span>

      <span className="min-w-0 truncate cap-14 text-surface-50" title={asset.name}>
        {asset.orbital_title ?? asset.name}
      </span>

      <span className="truncate cap-12 text-surface-300">
        {asset.asset_type ? formatTaxonomyLabel(asset.asset_type) : '—'}
      </span>

      <span className="flex min-w-0 items-center gap-2 cap-12 text-surface-300">
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-xs', ECO_MARKS[ecoKey] ?? 'bg-eco-agnostic')}
        />
        <span className="truncate">{formatTaxonomyLabel(ecoKey)}</span>
      </span>

      <span className="truncate font-mono tabular-nums cap-12 text-surface-300">
        {shortVersions(asset.orbital_supported_versions)}
      </span>

      <span className="text-right font-mono tabular-nums cap-12 text-surface-100">
        {formatBytes(asset.file_size)}
      </span>

      <span className="truncate cap-12 text-surface-400" title={source}>
        {source}
      </span>

      <span className="font-mono tabular-nums cap-12 text-surface-400">
        {asset.created_date ? asset.created_date.slice(0, 10) : '—'}
      </span>

      <span
        className={cn(
          'w-fit rounded-sm px-2 py-0.5 font-mono cap-11 font-semibold',
          matched ? 'bg-success-500/16 text-success-500' : 'bg-surface-800 text-surface-300',
        )}
      >
        {matched ? 'Matched' : 'Unmatched'}
      </span>
    </div>
  );
}

/**
 * Compact engine range for a 100px column. `formatSupportedVersions` produces
 * the full "4.26, 5.1 – 5.2" form, which is right for the inspector and too
 * wide here, so a multi-run list collapses to first–last.
 */
function shortVersions(raw: string | null): string {
  if (!raw) return '—';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return '—';
    const nums = parsed
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.replace(/^UE\s*/i, '').trim())
      .filter(Boolean);
    if (nums.length === 0) return '—';
    if (nums.length === 1) return nums[0];
    const sorted = [...nums].sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));
    return `${sorted[0]}–${sorted[sorted.length - 1]}`;
  } catch {
    return '—';
  }
}
