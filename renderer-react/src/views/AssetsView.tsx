import type { SortOption } from '@omnidex/types/db';
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { getQueryKey } from '@trpc/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GridErrorState } from '@/components/GridErrorState';
import { useViewStatus } from '@/components/layout/StatusBar';
import { toast } from '@/components/ui/toaster';
import type { AssetCardShape } from '@/features/assets/AssetCard';
import { AssetGrid } from '@/features/assets/AssetGrid';
import { AssetTable } from '@/features/assets/AssetTable';
import { AssetToolbar, type AssetView } from '@/features/assets/AssetToolbar';
import { BulkActionBar } from '@/features/assets/BulkActionBar';
import { FilterChips } from '@/features/assets/FilterChips';
import { activeFacets, buildAssetFilter, toggleFacet } from '@/features/assets/facets';
import { InspectorPanel } from '@/features/assets/InspectorPanel';
import { SourceList } from '@/features/assets/SourceList';
import { useAssetSelection } from '@/features/assets/useAssetSelection';
import { useHotkey } from '@/hooks/useHotkey';
import { buildAssetMenuItems, useNativeContextMenu } from '@/hooks/useNativeContextMenu';
import { trpc } from '@/ipc/trpc';
import { useModals } from '@/stores/modals';

const VIEW_KEY = 'omnidex.assetView';

// One network page. Big enough that the first page fills any viewport without
// a second round-trip, small enough that we don't ship 1k rows up front.
const PAGE_SIZE = 200;
// Pre-fetch the next page while the user is still ~2 rows from the bottom so
// the grid never visibly stalls on a fast scroll.
const PREFETCH_PX = 600;

interface SearchSchema {
  readonly q?: string;
}

export function AssetsView() {
  // TanStack Router exposes the search object; q is the global nav search.
  const search = useSearch({ strict: false }) as SearchSchema;
  const query = (search.q ?? '').trim();
  const isSearching = query.length > 0;
  // Facets compose. Empty set = "All assets"; see `facets.ts` for the axis
  // rules and why within-axis selection replaces rather than accumulates.
  const [facets, setFacets] = useState<ReadonlySet<string>>(() => new Set<string>());
  const onToggleFacet = useCallback(
    (key: string) => setFacets((prev) => toggleFacet(prev, key)),
    [],
  );
  const clearFacets = useCallback(() => setFacets(new Set<string>()), []);
  const [sort, setSort] = useState<SortOption>('date_added_desc');
  // Table is the better default for an unmatched-heavy library, but the choice
  // persists because it is a working preference, not a one-off.
  const [view, setView] = useState<AssetView>(() => {
    if (typeof window === 'undefined') return 'grid';
    return window.localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'grid';
  });
  const onViewChange = useCallback((next: AssetView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private mode / quota — the view still switches for this session.
    }
  }, []);

  // The sidebar selection, as the filter both list procedures take.
  const filter = useMemo(() => buildAssetFilter(facets), [facets]);
  const chips = useMemo(() => activeFacets(facets), [facets]);

  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const openMenu = useNativeContextMenu();
  const openAddToCollection = useModals((s) => s.openAddToCollection);
  const openTagging = useModals((s) => s.openTagging);
  const openBulkTagging = useModals((s) => s.openBulkTagging);
  const openConfirm = useModals((s) => s.openConfirm);

  // Two list sources, one virtualized grid:
  //   - default: `assets.listCards`, the sidebar-scoped + sorted listing.
  //   - active search: `assets.search`, FTS5/BM25-ranked. Search replaces the
  //     sort (relevance wins) but carries the same `filter`, so a facet set
  //     before typing keeps applying instead of silently lapsing.
  // Offset is injected per-page via `pageParam`, so it is NOT part of these
  // input objects — that keeps each tRPC infinite query key stable so the
  // optimistic favorite writes below can find and patch the on-screen cache.
  const listInput = useMemo(() => ({ filter, sort, limit: PAGE_SIZE }), [filter, sort]);
  const searchInput = useMemo(() => ({ query, filter, limit: PAGE_SIZE }), [query, filter]);
  const activeKey = isSearching
    ? getQueryKey(trpc.assets.search, searchInput, 'infinite')
    : getQueryKey(trpc.assets.listCards, listInput, 'infinite');

  // tRPC injects the page param as `cursor`, but the backend reads `offset`, so
  // the native `useInfiniteQuery` hook can't drive offset paging. Drive it
  // ourselves through the typed vanilla client, reusing the tRPC infinite query
  // key so the cache stays consistent. Swapping `activeKey` swaps the whole
  // query (resetting paging to 0) — exactly the search↔browse toggle.
  const cards = useInfiniteQuery({
    queryKey: activeKey,
    queryFn: ({ pageParam }) =>
      isSearching
        ? utils.client.assets.search.query({ ...searchInput, offset: pageParam })
        : utils.client.assets.listCards.query({ ...listInput, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.reduce((n, page) => n + page.length, 0),
  });

  const items = useMemo<AssetCardShape[]>(
    () => (cards.data?.pages.flat() as AssetCardShape[] | undefined) ?? [],
    [cards.data],
  );

  const total = trpc.assets.count.useQuery(filter);
  // Only fetched while searching; the status bar reports whichever count
  // matches what the grid is actually listing.
  const searchTotal = trpc.assets.searchCount.useQuery({ query, filter }, { enabled: isSearching });
  const shownTotal = isSearching ? (searchTotal.data ?? null) : (total.data ?? null);
  const stats = trpc.assets.stats.useQuery();

  // Scan-location names for the table's Source column, so a row says where it
  // came from rather than printing a numeric id.
  const locations = trpc.scanLocations.list.useQuery();
  const locationNames = useMemo(() => {
    const rows = (locations.data ?? []) as ReadonlyArray<{ id: number; name: string }>;
    return new Map(rows.map((l) => [l.id, l.name]));
  }, [locations.data]);

  // Selection is plural. The ordered id list must match render order, because
  // that is what a shift-range resolves against.
  const orderedIds = useMemo(() => items.map((a) => a.id), [items]);
  const selection = useAssetSelection(orderedIds);
  const { selected, activeId, count: selectedCount, select, selectAll, clear, forget } = selection;

  // Publish into the status bar. Cleared on unmount so another route does not
  // inherit this view's numbers.
  const setViewStatus = useViewStatus((s) => s.setViewStatus);
  const resetViewStatus = useViewStatus((s) => s.resetViewStatus);
  useEffect(() => {
    setViewStatus({ shown: shownTotal, selected: selectedCount, viewMode: view });
  }, [setViewStatus, shownTotal, selectedCount, view]);
  useEffect(() => resetViewStatus, [resetViewStatus]);

  useHotkey({
    key: 'a',
    meta: true,
    handler: (e) => {
      e.preventDefault();
      selectAll();
    },
  });
  useHotkey({ key: 'Escape', handler: clear, enabled: selectedCount > 0 });

  // Capture-phase scroll listener on the wrapper: scroll events don't bubble,
  // but they DO reach capturing ancestors, so we can react to the grid's own
  // scroll container without reaching into AssetGrid.
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = cards;
  const onGridScroll = useCallback(
    (event: Event) => {
      if (!hasNextPage || isFetchingNextPage) return;
      const el = event.target as HTMLElement | null;
      if (!el || typeof el.scrollTop !== 'number') return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= PREFETCH_PX) {
        void fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage],
  );
  useEffect(() => {
    const wrap = gridWrapRef.current;
    if (!wrap) return;
    wrap.addEventListener('scroll', onGridScroll, { capture: true });
    return () => wrap.removeEventListener('scroll', onGridScroll, { capture: true });
  }, [onGridScroll]);

  const favorite = trpc.assets.setFavorite.useMutation({
    onMutate: async ({ ids, favorite: next }) => {
      // Optimistic: flip the rows in whichever infinite cache is on screen
      // (listCards OR search). Patch `activeKey` generically — both queries
      // share the AssetCardShape page shape — so favoriting feels identical in
      // search mode. Cancel in-flight reads first so a late refetch can't
      // clobber the optimism.
      await queryClient.cancelQueries({ queryKey: activeKey });
      const prev = queryClient.getQueryData<InfiniteData<AssetCardShape[]>>(activeKey);
      const idSet = new Set(ids);
      queryClient.setQueryData<InfiniteData<AssetCardShape[]>>(activeKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) =>
                page.map((row) => (idSet.has(row.id) ? { ...row, is_favorite: next } : row)),
              ),
            }
          : old,
      );
      return { prev, key: activeKey };
    },
    onError: (_err, _vars, ctx) => {
      // Roll back the same cache we patched; the global mutation-cache toast
      // surfaces the error.
      if (ctx?.prev) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () => {
      // Sidebar favorite tally is cheap and must stay correct.
      void utils.assets.favoriteCount.invalidate();
    },
  });

  const remove = trpc.assets.delete.useMutation({
    onSuccess: () => {
      void utils.assets.invalidate();
    },
  });

  const onToggleFavorite = (id: number, next: boolean) => {
    // Guard against double-clicks desyncing the optimistic cache.
    if (favorite.isPending) return;
    favorite.mutate({ ids: [id], favorite: next });
  };

  const onContextMenu = (asset: AssetCardShape) =>
    openMenu(
      buildAssetMenuItems({
        id: asset.id,
        filePath: asset.file_path,
        isFavorite: asset.is_favorite,
        onToggleFavorite: () => onToggleFavorite(asset.id, !asset.is_favorite),
        onAddToCollection: () => openAddToCollection([asset.id]),
        onManageTags: () => openTagging(asset.id),
        onDelete: () =>
          openConfirm({
            title: 'Delete asset?',
            body: `"${asset.orbital_title ?? asset.name}" will be removed from your library. This does not delete the file on disk.`,
            confirmLabel: 'Delete',
            destructive: true,
            onConfirm: async () => {
              await remove.mutateAsync([asset.id]);
              forget([asset.id]);
              toast.success('Asset deleted');
            },
          }),
      }),
    );

  // ---- Bulk actions. Every mutation below already accepted an array; the UI
  // simply never had a batch to hand it. ----
  const selectedIdList = useMemo(() => [...selected], [selected]);

  const onBulkFavorite = () => {
    if (favorite.isPending || selectedIdList.length === 0) return;
    // Favorite the whole selection unless it is already entirely favorited,
    // in which case the gesture means "unfavorite".
    const selectedRows = items.filter((a) => selected.has(a.id));
    const allFavorited = selectedRows.length > 0 && selectedRows.every((a) => a.is_favorite);
    favorite.mutate({ ids: selectedIdList, favorite: !allFavorited });
  };

  const onBulkRemove = () =>
    openConfirm({
      title: `Delete ${selectedIdList.length} assets?`,
      body: 'They will be removed from your library. This does not delete the files on disk.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await remove.mutateAsync(selectedIdList);
        forget(selectedIdList);
        toast.success(`${selectedIdList.length} assets deleted`);
      },
    });

  return (
    <div className="flex h-full w-full min-w-0 flex-row">
      <SourceList selectedKeys={facets} onSelect={onToggleFacet} />
      <section className="relative flex min-w-0 flex-1 flex-col">
        <AssetToolbar
          total={total.data ?? 0}
          sort={sort}
          onSortChange={setSort}
          view={view}
          onViewChange={onViewChange}
          enrichedCount={stats.data?.with_orbital ?? 0}
        />
        <FilterChips facets={chips} onRemove={onToggleFacet} onClear={clearFacets} />
        <div className="min-h-0 flex-1" ref={gridWrapRef}>
          {cards.isError ? (
            <GridErrorState message={cards.error.message} onRetry={() => void cards.refetch()} />
          ) : view === 'table' ? (
            <AssetTable
              assets={items}
              isLoading={cards.isPending}
              selectedIds={selected}
              activeId={activeId}
              onSelect={select}
              onContextMenu={onContextMenu}
              locationNames={locationNames}
              allSelected={items.length > 0 && selectedCount === items.length}
              onToggleAll={() => (selectedCount === items.length ? clear() : selectAll())}
            />
          ) : (
            <AssetGrid
              assets={items}
              isLoading={cards.isPending}
              selectedIds={selected}
              activeId={activeId}
              onSelect={select}
              onToggleFavorite={onToggleFavorite}
              onContextMenu={onContextMenu}
              {...(isSearching
                ? {
                    emptyState: {
                      title: `No matches for “${query}”`,
                      hint: 'Try fewer or different words.',
                    },
                  }
                : {})}
            />
          )}
        </div>
        <BulkActionBar
          count={selectedCount}
          onFavorite={onBulkFavorite}
          onAddTags={() => openBulkTagging(selectedIdList)}
          onNewCollection={() => openAddToCollection(selectedIdList)}
          onRemove={onBulkRemove}
          onClear={clear}
        />
      </section>
      <InspectorPanel assetId={activeId} onClose={clear} />
    </div>
  );
}
