import { Link } from '@tanstack/react-router';
import { Activity, CircleDashed, Folder, Heart, Library, Package, Star, Store } from 'lucide-react';
import { useState } from 'react';
import { ALL_KEY } from '@/features/assets/facets';
import { trpc } from '@/ipc/trpc';
import { cn } from '@/lib/cn';
import { formatCount, formatTaxonomyLabel } from '@/lib/format';

/**
 * Ecosystem colour channel. Platform ("which DCC") and kind ("3D model") were
 * both rendered as the same neutral lucide folder, so the axis that is about to
 * matter most — Blender, Maya, Houdini and ZBrush are near-term — had no visual
 * language at all. Ecosystems get a hue; categories stay neutral, so one glance
 * answers "which DCC" without kind competing for the same signal.
 *
 * Keys are the raw DB values. Anything unlisted falls back to the neutral mark
 * rather than inventing a hue that would imply a distinction we cannot back.
 */
const ECOSYSTEM_MARKS: Readonly<Record<string, string>> = {
  unreal_engine: 'bg-eco-unreal',
  blender: 'bg-eco-blender',
  agnostic: 'bg-eco-agnostic',
  unknown: 'bg-eco-unclassified',
};

/** Categories shown before the disclosure. */
const CATEGORY_PREVIEW = 12;

/**
 * ponytail: row counts are unconditional — each comes from its own aggregate
 * proc over the whole library, so with "Unmatched" already active the Unreal
 * row still reads 2,570 while selecting it yields 2,269. The chip row and the
 * status bar both report the real intersection, so the app never *asserts* the
 * wrong total, but the preview number is optimistic.
 *
 * Making them conditional means every count proc taking the current filter and
 * re-running on each toggle — five extra round-trips per click against a table
 * where `categoryCounts` already does a `json_each` explode over 2,799 rows.
 * Worth doing when a facet's real yield is regularly surprising; not worth it
 * to shave 300 off one number.
 */

interface SourceListProps {
  /** Active facet keys. Empty means "All assets" — no filter, not a filter named all. */
  readonly selectedKeys: ReadonlySet<string>;
  /** Toggles one key. Composition rules live in `facets.ts`, not here. */
  readonly onSelect: (key: string) => void;
}

interface SourceNode {
  readonly key: string;
  readonly label: string;
  /** Neutral glyph. Mutually exclusive with `mark`. */
  readonly icon?: typeof Folder;
  /** Ecosystem colour swatch class. Mutually exclusive with `icon`. */
  readonly mark?: string;
  readonly count: number;
}

export function SourceList({ selectedKeys, onSelect }: SourceListProps) {
  const total = trpc.assets.totalCount.useQuery();
  const favorites = trpc.assets.favoriteCount.useQuery();
  const fab = trpc.assets.fabCount.useQuery();
  const categories = trpc.assets.categoryCounts.useQuery();
  const ecosystems = trpc.assets.ecosystemCounts.useQuery();
  const marketplace = trpc.assets.marketplaceSourceCounts.useQuery();
  const collections = trpc.collections.list.useQuery();
  const [categoriesExpanded, setCategoriesExpanded] = useState(false);

  const roots: SourceNode[] = [
    { key: 'all', label: 'All assets', icon: Package, count: total.data ?? 0 },
    { key: 'favorites', label: 'Favorites', icon: Heart, count: favorites.data ?? 0 },
    { key: 'fab', label: 'FAB library', icon: Star, count: fab.data ?? 0 },
  ];

  // Marketplace-match facets. `orbital` comes straight from the proc; `unmatched`
  // is its complement over the (non-Learn) library total, so the two always sum
  // to the All-assets count.
  const orbitalMatched = marketplace.data?.orbital ?? 0;
  const marketplaceRows: SourceNode[] = [
    { key: 'match:orbital', label: 'Orbital matched', icon: Store, count: orbitalMatched },
    {
      key: 'match:unmatched',
      label: 'Unmatched',
      icon: CircleDashed,
      count: Math.max(0, (total.data ?? 0) - orbitalMatched),
    },
  ];

  const ecosystemRows: SourceNode[] = Object.entries(ecosystems.data ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({
      key: `ecosystem:${key}`,
      label: formatTaxonomyLabel(key),
      mark: ECOSYSTEM_MARKS[key.toLowerCase()] ?? 'bg-eco-agnostic',
      count,
    }));

  const allCategoryRows: SourceNode[] = Object.entries(categories.data ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({
      key: `category:${key}`,
      label: formatTaxonomyLabel(key),
      icon: Folder,
      count,
    }));
  // Was `.slice(0, 20)` with nothing said about it, so category 21 was simply
  // unreachable. Never truncate a navigation list without saying so.
  const categoryRows = categoriesExpanded
    ? allCategoryRows
    : allCategoryRows.slice(0, CATEGORY_PREVIEW);
  const hiddenCategories = allCategoryRows.length - categoryRows.length;

  return (
    <nav
      aria-label="Asset library"
      className="flex h-full w-[240px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-surface-800/60 bg-surface-950 px-2 py-3"
    >
      <SourceGroup label="Library" nodes={roots} selectedKeys={selectedKeys} onSelect={onSelect} />

      {/* Collections came down from the nav. A list of bags belongs beside the
          other ways to slice the library, not in the most valuable strip in the
          app — one collection did not earn a sixth of the primary navigation.
          These link out to the detail route rather than filtering in place,
          because a collection IS its own entity, not a facet. */}
      <Section id="source-group-collections">Collections</Section>
      {(collections.data ?? []).slice(0, 8).map((c) => (
        <Link
          key={c.id ?? c.name}
          to="/collections/$collectionId"
          params={{ collectionId: String(c.id) }}
          className="group relative flex h-7 items-center gap-2 rounded-md px-2 cap-12 text-surface-300 no-underline transition-colors hover:bg-surface-900 hover:text-surface-100"
        >
          <Library size={12} strokeWidth={2} className="shrink-0 text-surface-400" />
          <span className="flex-1 truncate text-left">{c.name}</span>
          <span className="font-mono tabular-nums cap-10 text-surface-400">
            {formatCount(c.asset_count)}
          </span>
        </Link>
      ))}
      <Link
        to="/collections"
        className="mx-2 rounded-md px-2 py-1 font-mono cap-10 text-surface-400 no-underline transition-colors hover:bg-surface-900 hover:text-surface-200"
      >
        Manage collections
      </Link>

      <SourceGroup
        label="Marketplace"
        nodes={marketplaceRows}
        selectedKeys={selectedKeys}
        onSelect={onSelect}
      />

      {ecosystemRows.length > 0 ? (
        <SourceGroup
          label="Ecosystems"
          nodes={ecosystemRows}
          selectedKeys={selectedKeys}
          onSelect={onSelect}
        />
      ) : null}

      {/* Health was a nav tab; library state is what the Library destination
          is for. */}
      <Section id="source-group-health">Library state</Section>
      <Link
        to="/health"
        className="group relative flex h-7 items-center gap-2 rounded-md px-2 cap-12 text-surface-300 no-underline transition-colors hover:bg-surface-900 hover:text-surface-100"
      >
        <Activity size={12} strokeWidth={2} className="shrink-0 text-surface-400" />
        <span className="flex-1 truncate">Health</span>
      </Link>

      {categoryRows.length > 0 ? (
        <>
          <SourceGroup
            label="Categories"
            nodes={categoryRows}
            selectedKeys={selectedKeys}
            onSelect={onSelect}
          />
          {hiddenCategories > 0 || categoriesExpanded ? (
            <button
              type="button"
              onClick={() => setCategoriesExpanded((v) => !v)}
              className="mx-2 mt-0.5 rounded-md px-2 py-1 text-left font-mono cap-10 text-surface-400 transition-colors hover:bg-surface-900 hover:text-surface-200"
            >
              {categoriesExpanded ? 'Show fewer' : `+${formatCount(hiddenCategories)} more`}
            </button>
          ) : null}
        </>
      ) : null}
    </nav>
  );
}

function SourceGroup({
  label,
  nodes,
  selectedKeys,
  onSelect,
}: {
  readonly label: string;
  readonly nodes: ReadonlyArray<SourceNode>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelect: (key: string) => void;
}) {
  const headingId = `source-group-${label.toLowerCase()}`;
  return (
    <ul aria-labelledby={headingId} className="contents">
      <li className="contents">
        <Section id={headingId}>{label}</Section>
      </li>
      {nodes.map((node) => (
        <li key={node.key} className="contents">
          <NodeRow
            node={node}
            // "All assets" is the absence of facets, so it lights up when the
            // set is empty rather than by being in it.
            active={node.key === ALL_KEY ? selectedKeys.size === 0 : selectedKeys.has(node.key)}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
}

function Section({ id, children }: { readonly id?: string; readonly children: React.ReactNode }) {
  return (
    <h3
      id={id}
      className="mt-2 px-2 pb-1 pt-1 font-mono cap-9 font-semibold uppercase tracking-[0.18em] text-surface-400"
    >
      {children}
    </h3>
  );
}

function NodeRow({
  node,
  active,
  onSelect,
}: {
  readonly node: SourceNode;
  readonly active: boolean;
  readonly onSelect: (key: string) => void;
}) {
  const Icon = node.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.key)}
      // `aria-pressed`, not `aria-current`: these compose now, so a row is a
      // toggle in a set rather than "the page you are on".
      aria-pressed={active}
      className={cn(
        'group relative flex h-7 items-center gap-2 rounded-sm px-2 cap-12 transition-colors [transition-duration:var(--duration-micro)]',
        active
          ? 'bg-surface-800/80 font-medium text-surface-50'
          : 'text-surface-300 hover:bg-surface-900 hover:text-surface-100',
      )}
    >
      {/* Non-color selection cue: a left accent bar so the active row is */}
      {/* distinguishable without relying on background/text color alone. */}
      {active ? (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent-400"
        />
      ) : null}
      {node.mark ? (
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-xs', node.mark)} />
      ) : Icon ? (
        <Icon size={12} strokeWidth={2} className="text-surface-400 shrink-0" />
      ) : null}
      {/* No CSS `capitalize` here — it left "Unreal_engine" with its underscore
          intact. Every taxonomy label goes through one formatter now. */}
      <span className="flex-1 truncate text-left">{node.label}</span>
      <span className="font-mono cap-10 tabular-nums text-surface-400">
        {formatCount(node.count)}
      </span>
    </button>
  );
}
