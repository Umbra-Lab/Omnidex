import { Check, Heart, MoreHorizontal, Star } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { resolveThumbnail } from '@/lib/assetUrl';
import { cn } from '@/lib/cn';
import { formatBytes, formatRating, formatTaxonomyLabel } from '@/lib/format';
import type { SelectModifiers } from './useAssetSelection';

/** Ecosystem hue, mirroring the sidebar and the table so a mark means one thing. */
const ECO_MARKS: Readonly<Record<string, string>> = {
  unreal_engine: 'bg-eco-unreal',
  blender: 'bg-eco-blender',
  agnostic: 'bg-eco-agnostic',
  unknown: 'bg-eco-unclassified',
};

/** First–last engine version, compact enough for a card metadata line. */
function shortEngine(raw: string | null): string {
  if (!raw) return '—';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return '—';
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

// Pull the first non-empty string out of a JSON-stringified array.
// Tolerates both `["a","b"]` (FAB tag slugs) and `[{"name":"a"}]` shapes.
function firstFromJsonArray(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const item of parsed) {
      if (typeof item === 'string' && item.trim()) return item.trim();
      if (
        item &&
        typeof item === 'object' &&
        'name' in item &&
        typeof (item as { name: unknown }).name === 'string'
      ) {
        const n = (item as { name: string }).name.trim();
        if (n) return n;
      }
    }
  } catch {
    // ignore malformed JSON
  }
  return null;
}

// Convert "weapons", "vehicles_air", "3D Asset", "unreal_pack" → "Weapons",
// "Vehicles Air", "3D Asset", "Unreal Pack". A label longer than 16
// characters keeps its whole leading words ("Tutorials Examples" →
// "Tutorials") so the metadata row never shows a cut-off word.
function formatCardLabel(raw: string): string {
  const cleaned = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const titled = cleaned
    .split(' ')
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
  if (titled.length <= 16) return titled;
  const words = titled.split(' ');
  let short = words[0];
  for (const w of words.slice(1)) {
    if (`${short} ${w}`.length > 16) break;
    short = `${short} ${w}`;
  }
  return short.length <= 16 ? short : `${short.slice(0, 15)}…`;
}

// Priority: FAB tag (most descriptive) → orbital category → asset_type.
function deriveCardLabel(asset: AssetCardShape): string | null {
  const fromTags = firstFromJsonArray(asset.tags);
  if (fromTags) return formatCardLabel(fromTags);
  const fromCats = firstFromJsonArray(asset.orbital_categories);
  if (fromCats) return formatCardLabel(fromCats);
  if (asset.asset_type) return formatCardLabel(asset.asset_type);
  return null;
}

export interface AssetCardShape {
  readonly id: number;
  readonly name: string;
  readonly file_path: string | null;
  readonly asset_type: string | null;
  readonly orbital_title: string | null;
  readonly orbital_seller_name: string | null;
  readonly orbital_rating_average: number | null;
  readonly orbital_rating_count: number | null;
  readonly orbital_price: number | null;
  readonly thumbnail_path: string | null;
  readonly orbital_thumbnail_url: string | null;
  readonly file_size: number;
  readonly is_favorite: boolean;
  readonly fab_owned: boolean;
  readonly tags: string | null;
  readonly orbital_categories: string | null;
  readonly created_date: string;
  readonly asset_ecosystem: string | null;
  readonly ecosystem: string | null;
  readonly orbital_supported_versions: string | null;
  readonly scan_location_id: number | null;
  readonly matched_orbital_product_slug: string | null;
  readonly missing_since: string | null;
}

interface AssetCardProps {
  readonly asset: AssetCardShape;
  /** In the current multi-selection. */
  readonly selected?: boolean;
  /** The one row the inspector is following. Always also `selected`. */
  readonly active?: boolean;
  /** True while any selection exists — pins the checkboxes open across the grid. */
  readonly selectionActive?: boolean;
  readonly onClick?: (id: number, modifiers: SelectModifiers) => void;
  readonly onToggleFavorite?: (id: number, next: boolean) => void;
  readonly onContextMenu?: (event: React.MouseEvent) => void;
}

export function AssetCard({
  asset,
  selected,
  active,
  selectionActive,
  onClick,
  onToggleFavorite,
  onContextMenu,
}: AssetCardProps) {
  const thumb = resolveThumbnail(asset);
  const [imgError, setImgError] = useState(false);
  const hasImage = Boolean(thumb) && !imgError;
  const rating = asset.orbital_rating_average;
  const displayName = asset.orbital_title ?? asset.name;
  const label = deriveCardLabel(asset);
  const ecoKey = (asset.asset_ecosystem ?? asset.ecosystem ?? 'unknown').toLowerCase();
  const engine = shortEngine(asset.orbital_supported_versions);

  return (
    // role=button + key handler instead of a real <button> so the favorite
    // control below can be its own <button> without nesting (invalid HTML).
    // biome-ignore lint/a11y/useSemanticElements: a real <button> would nest the favorite <button> inside it (invalid HTML); role+keydown is the supported pattern
    <div
      role="button"
      tabIndex={0}
      data-testid="asset-card"
      data-asset-id={asset.id}
      onClick={(e) => onClick?.(asset.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.(asset.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
        }
      }}
      onContextMenu={onContextMenu}
      aria-pressed={selected ?? false}
      className={cn(
        // Opaque surface-900, not 900/40. Composited over the surface-950 page
        // the old translucent fill landed ~2 OKLCH lightness points from its
        // own background; DESIGN.md requires >= 5 where layers meet, and below
        // that a card stops reading as an object at arm's length.
        // select-none is load-bearing, not cosmetic: once shift-click means
        // "extend the range", the browser also reads it as "extend the text
        // selection" and paints a blue smear across every card in between.
        'group relative flex cursor-pointer select-none flex-col overflow-hidden rounded-md border bg-surface-900 text-left outline-none transition-all [transition-duration:var(--duration-micro)] focus-visible:ring-1 focus-visible:ring-accent-500/60',
        // Selection reads as a 2px accent edge plus a lifted background, not a
        // 1px hairline on a card that was already invisible. The edge is a
        // ring, not a wider border, so selecting never reflows the grid by a
        // pixel. The active row (the one the inspector follows) takes the ring
        // at full strength so it stays findable inside a large selection.
        'border',
        selected
          ? 'border-accent-500 bg-surface-800 ring-2'
          : 'border-surface-800/60 hover:border-surface-700 hover:bg-surface-850',
        selected && active ? 'ring-accent-500' : selected ? 'ring-accent-500/60' : '',
      )}
    >
      {/* The card degrades instead of blanking. 88% of this library has no
          thumbnail, and spending 135px on a grey gradient and a 32px icon
          bought a wall of noise carrying one line of information. With no
          image the well collapses to a control strip and the reclaimed height
          goes to what IS known — see the metadata block below. */}
      <div
        className={cn('relative overflow-hidden bg-surface-950', hasImage ? 'aspect-video' : 'h-8')}
      >
        {hasImage ? (
          <img
            src={thumb ?? ''}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.015]"
          />
        ) : null}

        {/* Selection checkbox. Pinned open once any selection exists so the
            grid stops being a field of hover-only targets mid-triage. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick?.(asset.id, { shift: e.shiftKey, meta: true });
          }}
          className={cn(
            'absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border backdrop-blur transition-all',
            selected
              ? 'border-accent-500 bg-accent-500 text-accent-on opacity-100'
              : 'border-surface-500 bg-surface-950/70 text-transparent hover:border-surface-300',
            selected || selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          aria-label={selected ? 'Deselect asset' : 'Select asset'}
        >
          <Check size={12} strokeWidth={3} />
        </button>

        <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
          {/* Favorite persists at low opacity rather than hiding until hover.
              It is the fastest triage verb in the app and it was invisible. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite?.(asset.id, !asset.is_favorite);
            }}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md bg-surface-950/60 backdrop-blur transition-all',
              asset.is_favorite
                ? 'text-accent-400 opacity-100'
                : 'text-surface-300 opacity-60 hover:text-accent-300 group-hover:opacity-100',
            )}
            aria-label={asset.is_favorite ? 'Remove favorite' : 'Add favorite'}
          >
            <Heart size={12} fill={asset.is_favorite ? 'currentColor' : 'none'} strokeWidth={2} />
          </button>

          {/* Visible handle for the context menu, which was previously only
              reachable by right-click with nothing on screen to suggest it. */}
          {onContextMenu ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onContextMenu(e);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-950/60 text-surface-300 opacity-0 backdrop-blur transition-all group-hover:opacity-100 hover:text-surface-50"
              aria-label="More actions"
            >
              <MoreHorizontal size={13} strokeWidth={2} />
            </button>
          ) : null}
        </div>

        {/* A collection can still reference a pack that left the disk — the
            prune keeps the row so the membership survives a rename. Say so
            rather than showing it as if it were openable. */}
        {asset.missing_since ? (
          <div className="absolute bottom-1.5 left-1.5">
            <Badge variant="outline" className="border-warning-500/60 text-warning-300">
              Missing
            </Badge>
          </div>
        ) : asset.fab_owned ? (
          <div className="absolute bottom-1.5 left-1.5">
            <Badge variant="accent">FAB</Badge>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-[58px] flex-1 flex-col gap-1 px-2.5 py-2">
        <h3
          className={cn(
            'cap-12 font-medium text-surface-50',
            // Thumbnail-less cards have the room for a second line, and the
            // full name is the single most useful thing they can show.
            hasImage ? 'truncate' : 'line-clamp-2',
          )}
          title={displayName}
        >
          {displayName}
        </h3>
        {!hasImage ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono cap-9 text-surface-400">
            <span className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className={cn('size-1.5 rounded-xs', ECO_MARKS[ecoKey] ?? 'bg-eco-agnostic')}
              />
              {formatTaxonomyLabel(ecoKey)}
            </span>
            <span className="tabular-nums">{formatBytes(asset.file_size)}</span>
            {engine !== '—' ? <span className="tabular-nums">UE {engine}</span> : null}
          </div>
        ) : null}
        <div className="flex items-center gap-2 cap-11 text-surface-400">
          <div className="flex min-w-0 items-center gap-1.5">
            {label ? (
              <Badge variant="outline" className="shrink-0 px-1.5 py-0 cap-9 uppercase">
                {label}
              </Badge>
            ) : null}
            <span
              className="truncate font-mono tabular-nums text-surface-400"
              title={asset.orbital_seller_name ?? ''}
            >
              {asset.orbital_seller_name ?? ' '}
            </span>
          </div>
          {rating != null ? (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 font-mono tabular-nums text-surface-300">
              <Star size={9} className="fill-accent-400 text-accent-400" strokeWidth={0} />
              {formatRating(rating)}
              {asset.orbital_rating_count != null && asset.orbital_rating_count > 0 ? (
                <span className="ml-0.5 text-surface-400">({asset.orbital_rating_count})</span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
