import { useVirtualizer } from '@tanstack/react-virtual';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { AssetCard, type AssetCardShape } from './AssetCard';
import type { SelectModifiers } from './useAssetSelection';

interface AssetGridProps {
  readonly assets: ReadonlyArray<AssetCardShape>;
  readonly density?: number;
  readonly isLoading?: boolean;
  /** Every selected id. Empty set = nothing selected. */
  readonly selectedIds?: ReadonlySet<number>;
  /** The row the inspector follows. */
  readonly activeId?: number | null;
  readonly onSelect?: (id: number, modifiers: SelectModifiers) => void;
  readonly onToggleFavorite?: (id: number, next: boolean) => void;
  /** Per-asset native context-menu handler, built by the consuming view. */
  readonly onContextMenu?: (asset: AssetCardShape) => (event: React.MouseEvent) => void;
  /** Overrides the empty-grid copy (e.g. a search "no matches" message). */
  readonly emptyState?: { readonly title: string; readonly hint?: string };
}

// Card = 16:9 image + ~58px metadata strip. With 240px-ish columns the image
// is ~135px tall, so 200 covers it with breathing room. Bump if cards clip.
const CARD_HEIGHT = 200;
const GAP = 12;
const MIN_CARD_WIDTH = 240;

export function AssetGrid({
  assets,
  density,
  isLoading,
  selectedIds,
  activeId,
  onSelect,
  onToggleFavorite,
  onContextMenu,
  emptyState,
}: AssetGridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = useMemo(() => {
    if (density && density > 0) return density;
    return Math.max(2, Math.floor((containerWidth + GAP) / (MIN_CARD_WIDTH + GAP)));
  }, [containerWidth, density]);

  const rows = useMemo(() => {
    const buckets: AssetCardShape[][] = [];
    for (let i = 0; i < assets.length; i += columns) {
      buckets.push(assets.slice(i, i + columns));
    }
    return buckets;
  }, [assets, columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_HEIGHT + GAP,
    // Larger overscan keeps the wheel jank-free at the cost of a few extra
    // off-screen rows; the cards are cheap (image + 2 text spans).
    overscan: 12,
  });

  if (isLoading && assets.length === 0) {
    // Mirror the loaded grid's geometry exactly — same scroll padding, column
    // template, gap, and per-card height — so swapping skeletons for real cards
    // produces zero layout shift.
    return (
      <div ref={scrollRef} className="h-full overflow-auto px-3 py-2">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: GAP,
            padding: `0 ${GAP / 2}px`,
          }}
        >
          {Array.from({ length: columns * 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
            <Skeleton key={i} className="w-full" style={{ height: CARD_HEIGHT }} />
          ))}
        </div>
      </div>
    );
  }

  if (!isLoading && assets.length === 0) {
    const title = emptyState?.title ?? 'No assets found.';
    const hint = emptyState?.hint ?? 'Add a scan location to start indexing.';
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-surface-400">
        <div className="cap-14">{title}</div>
        {hint ? <div className="font-mono cap-11 text-surface-400">{hint}</div> : null}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-auto px-3 py-2">
      {/* No role here: a transform-virtualized list can't honestly satisfy the
          grid pattern (no row/gridcell structure), so we don't claim it. The
          per-card <div role="button"> handles keyboard semantics. */}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (!row) return null;
          return (
            <div
              key={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: CARD_HEIGHT,
                transform: `translateY(${virtualRow.start}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: GAP,
                padding: `0 ${GAP / 2}px`,
              }}
            >
              {row.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  selected={selectedIds?.has(asset.id) ?? false}
                  active={activeId === asset.id}
                  selectionActive={(selectedIds?.size ?? 0) > 0}
                  onClick={onSelect}
                  {...(onToggleFavorite ? { onToggleFavorite } : {})}
                  {...(onContextMenu ? { onContextMenu: onContextMenu(asset) } : {})}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
