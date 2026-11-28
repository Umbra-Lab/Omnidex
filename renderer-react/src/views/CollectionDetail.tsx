import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Boxes, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { GridErrorState } from '@/components/GridErrorState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toaster';
import type { AssetCardShape } from '@/features/assets/AssetCard';
import { AssetGrid } from '@/features/assets/AssetGrid';
import { InspectorPanel } from '@/features/assets/InspectorPanel';
import { useAssetSelection } from '@/features/assets/useAssetSelection';
import { type ContextMenuItem, useNativeContextMenu } from '@/hooks/useNativeContextMenu';
import { trpc } from '@/ipc/trpc';
import { formatCount } from '@/lib/format';
import { useModals } from '@/stores/modals';

export function CollectionDetail() {
  const { collectionId } = useParams({ from: '/collections/$collectionId' });
  const id = Number(collectionId);
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const openMenu = useNativeContextMenu();
  const openConfirm = useModals((s) => s.openConfirm);
  const openAddToCollection = useModals((s) => s.openAddToCollection);

  const valid = Number.isFinite(id) && id > 0;
  const collection = trpc.collections.get.useQuery(id, { enabled: valid });
  const assets = trpc.collections.assets.useQuery(id, { enabled: valid });

  const items = useMemo(() => assets.data ?? [], [assets.data]);

  // Same selection model as AssetsView — the grid is the same component,
  // so it must behave the same way here.
  const orderedIds = useMemo(() => items.map((a) => a.id), [items]);
  const { selected, activeId, select, clear, forget } = useAssetSelection(orderedIds);

  const removeAssets = trpc.collections.removeAssets.useMutation({
    onSuccess: () => {
      void utils.collections.assets.invalidate(id);
      void utils.collections.get.invalidate(id);
      void utils.collections.list.invalidate();
    },
  });

  const removeCollection = trpc.collections.delete.useMutation({
    onSuccess: () => {
      void utils.collections.list.invalidate();
    },
  });

  // The header shows the new name at once; a failed save puts the old one back.
  const rename = trpc.collections.rename.useMutation({
    onMutate: ({ name: next }) => {
      const before = utils.collections.get.getData(id);
      if (before) utils.collections.get.setData(id, { ...before, name: next });
      return { before };
    },
    onSuccess: (found) => {
      if (!found) toast.error('That collection no longer exists');
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.before) utils.collections.get.setData(id, ctx.before);
      toast.error(`Couldn't rename collection: ${err.message}`);
    },
    onSettled: () => {
      void utils.collections.get.invalidate(id);
      void utils.collections.list.invalidate();
    },
  });

  const favorite = trpc.assets.setFavorite.useMutation({
    onSuccess: () => {
      void utils.assets.invalidate();
    },
  });

  const onToggleFavorite = (assetId: number, next: boolean) => {
    favorite.mutate({ ids: [assetId], favorite: next });
  };

  const removeOne = (asset: AssetCardShape) => {
    openConfirm({
      title: 'Remove from collection?',
      body: `"${asset.orbital_title ?? asset.name}" will be removed from this collection. The asset stays in your library.`,
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: async () => {
        await removeAssets.mutateAsync({ collection_id: id, asset_ids: [asset.id] });
        forget([asset.id]);
        toast.success('Removed from collection');
      },
    });
  };

  const onContextMenu = (asset: AssetCardShape) => {
    const menuItems: ContextMenuItem[] = [
      {
        id: 'reveal',
        label: 'Reveal in Finder',
        enabled: Boolean(asset.file_path),
        onSelect: () => {
          if (asset.file_path) void window.omnidex?.shell?.openFileLocation(asset.file_path);
        },
      },
      { id: 'sep-1', type: 'separator' },
      {
        id: 'favorite',
        label: asset.is_favorite ? 'Remove favorite' : 'Add favorite',
        onSelect: () => onToggleFavorite(asset.id, !asset.is_favorite),
      },
      {
        id: 'add-collection',
        label: 'Add to collection…',
        onSelect: () => openAddToCollection([asset.id]),
      },
      { id: 'sep-2', type: 'separator' },
      {
        id: 'remove',
        label: 'Remove from collection',
        onSelect: () => removeOne(asset),
      },
    ];
    return openMenu(menuItems);
  };

  const deleteCollection = () => {
    const name = collection.data?.name ?? 'this collection';
    openConfirm({
      title: 'Delete collection?',
      body: `"${name}" will be deleted. The assets inside stay in your library.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await removeCollection.mutateAsync(id);
        toast.success('Collection deleted');
        void navigate({ to: '/collections' });
      },
    });
  };

  if (!valid) {
    return (
      <div className="flex h-full w-full flex-col">
        <DetailHeader title="Collection" subtitle={null} onDelete={null} />
        <GridErrorState title="Collection not found" message={`Invalid id "${collectionId}".`} />
      </div>
    );
  }

  if (collection.isError) {
    return (
      <div className="flex h-full w-full flex-col">
        <DetailHeader title="Collection" subtitle={null} onDelete={null} />
        <GridErrorState
          message={collection.error.message}
          onRetry={() => void collection.refetch()}
        />
      </div>
    );
  }

  if (!collection.isPending && !collection.data) {
    return (
      <div className="flex h-full w-full flex-col">
        <DetailHeader title="Collection" subtitle={null} onDelete={null} />
        <GridErrorState title="Collection not found" message="It may have been deleted." />
      </div>
    );
  }

  const title = collection.data?.name ?? <Skeleton className="h-5 w-40" />;
  const subtitle = collection.isPending
    ? null
    : `${formatCount(items.length)} asset${items.length === 1 ? '' : 's'}`;

  return (
    <div className="flex h-full w-full min-w-0 flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
        <DetailHeader
          title={title}
          subtitle={subtitle}
          onDelete={deleteCollection}
          name={collection.data?.name ?? null}
          onRename={(next) => rename.mutate({ id, name: next })}
        />
        <div className="min-h-0 flex-1">
          {assets.isError ? (
            <GridErrorState message={assets.error.message} onRetry={() => void assets.refetch()} />
          ) : (
            <AssetGrid
              assets={items}
              isLoading={assets.isPending}
              selectedIds={selected}
              activeId={activeId}
              onSelect={select}
              onToggleFavorite={onToggleFavorite}
              onContextMenu={onContextMenu}
            />
          )}
        </div>
      </div>
      <InspectorPanel assetId={activeId} onClose={clear} />
    </div>
  );
}

interface DetailHeaderProps {
  readonly title: React.ReactNode;
  readonly subtitle: string | null;
  readonly onDelete: (() => void) | null;
  /** The current name, once loaded. Rename is offered only with it. */
  readonly name?: string | null;
  readonly onRename?: (name: string) => void;
}

function DetailHeader({ title, subtitle, onDelete, name, onRename }: DetailHeaderProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // Enter and Escape both end editing, and the blur that follows must not
  // commit a second time (or commit what Escape just threw away).
  const done = useRef(false);
  const canRename = onRename != null && name != null;

  const startEditing = () => {
    if (!canRename) return;
    done.current = false;
    setDraft(name);
  };
  const finish = (commit: boolean) => {
    if (done.current || draft == null) return;
    done.current = true;
    const next = draft.trim();
    setDraft(null);
    if (commit && next !== '' && next !== name) onRename?.(next);
  };

  return (
    <header className="flex h-10 items-center gap-3 border-b border-surface-800/60 px-3">
      <Link
        to="/collections"
        className="flex items-center gap-1 rounded-md px-1.5 py-1 cap-12 text-surface-400 transition-colors hover:bg-surface-900/80 hover:text-surface-200"
      >
        <ArrowLeft size={14} />
        Collections
      </Link>
      <Boxes size={14} className="text-accent-400" />
      {draft != null ? (
        <Input
          aria-label="Collection name"
          autoFocus
          maxLength={200}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              // Escape here only cancels the edit; keep it from any page handler.
              e.stopPropagation();
              finish(false);
            }
          }}
          // Switching to another window blurs the input too. That is not
          // "done", so a half-typed name stays in the editor instead of saving.
          onBlur={() => {
            if (document.hasFocus()) finish(true);
          }}
          className="h-7 w-64 min-w-0 font-display font-semibold"
        />
      ) : (
        <span className="min-w-0 truncate font-display cap-14 font-semibold text-surface-50">
          {title}
        </span>
      )}
      {subtitle ? (
        <span className="font-mono cap-10 uppercase tracking-[0.18em] text-surface-500">
          {subtitle}
        </span>
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        {canRename && draft == null ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-surface-400 hover:text-surface-100"
            onClick={startEditing}
          >
            <Pencil size={13} />
            Rename
          </Button>
        ) : null}
        {onDelete ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-surface-400 hover:text-danger-400"
            onClick={onDelete}
          >
            <Trash2 size={13} />
            Delete
          </Button>
        ) : null}
      </div>
    </header>
  );
}
