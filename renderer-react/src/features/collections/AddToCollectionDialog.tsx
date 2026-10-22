import { Check, FolderPlus, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toaster';
import { trpc } from '@/ipc/trpc';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useModals } from '@/stores/modals';

/**
 * Shared "Add to collection" dialog driven by `useModals().addToCollection`.
 *
 * Mounted once by `ModalHost`; every trigger just calls
 * `useModals().openAddToCollection(assetIds)`. Reads the store directly so
 * `ModalHost` renders `<AddToCollectionDialog />` with no props. Supports
 * picking an existing collection or creating one inline (create → addAssets
 * chained on the returned id).
 */
export function AddToCollectionDialog() {
  const addToCollection = useModals((s) => s.addToCollection);
  const close = useModals((s) => s.closeAddToCollection);
  const open = addToCollection != null;
  const assetIds = addToCollection?.assetIds ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent>
        {open ? <AddToCollectionBody assetIds={assetIds} onDone={close} /> : null}
      </DialogContent>
    </Dialog>
  );
}

interface AddToCollectionBodyProps {
  readonly assetIds: number[];
  readonly onDone: () => void;
}

/**
 * Inner body, remounted per-open (keyed by the dialog's open state) so the
 * "create new" draft and selection reset between invocations.
 */
function AddToCollectionBody({ assetIds, onDone }: AddToCollectionBodyProps) {
  const utils = trpc.useUtils();
  const collections = trpc.collections.list.useQuery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const count = assetIds.length;

  const onSuccess = async (collectionId: number, label: string) => {
    await utils.collections.list.invalidate();
    await utils.collections.get.invalidate(collectionId);
    // Refresh the member grid too, so adding to the collection currently open in
    // CollectionDetail shows the new member without a manual refetch.
    await utils.collections.assets.invalidate(collectionId);
    toast.success(`Added ${formatCount(count)} asset${count === 1 ? '' : 's'} to "${label}"`);
    onDone();
  };

  const addAssets = trpc.collections.addAssets.useMutation();
  const create = trpc.collections.create.useMutation();

  const pending = addAssets.isPending || create.isPending;

  const handleAdd = async () => {
    if (creating) {
      const name = newName.trim();
      if (!name) return;
      const id = await create.mutateAsync({
        name,
        description: null,
        color: null,
        icon: null,
        is_smart: null,
        smart_filter: null,
      });
      await addAssets.mutateAsync({ collection_id: id, asset_ids: assetIds });
      await onSuccess(id, name);
      return;
    }
    if (selectedId == null) return;
    const label = collections.data?.find((c) => c.id === selectedId)?.name ?? 'collection';
    await addAssets.mutateAsync({ collection_id: selectedId, asset_ids: assetIds });
    await onSuccess(selectedId, label);
  };

  const canSubmit = creating ? newName.trim().length > 0 : selectedId != null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add to collection</DialogTitle>
        <DialogDescription>
          {`Add ${formatCount(count)} selected asset${count === 1 ? '' : 's'} to a collection.`}
        </DialogDescription>
      </DialogHeader>

      <div className="flex max-h-72 flex-col gap-1.5 overflow-auto">
        {collections.isPending ? (
          Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
            <Skeleton key={i} className="h-9 w-full" />
          ))
        ) : collections.isError ? (
          <p className="px-1 py-4 text-center cap-12 text-danger-400">
            Couldn't load collections. {collections.error.message}
          </p>
        ) : !collections.data || collections.data.length === 0 ? (
          <p className="px-1 py-4 text-center cap-12 text-surface-500">
            No collections yet — create one below.
          </p>
        ) : (
          collections.data.map((c) => {
            if (c.id == null) return null;
            const active = !creating && selectedId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setCreating(false);
                  setSelectedId(c.id ?? null);
                }}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-sm border px-2.5 py-2 text-left cap-14 transition-colors',
                  active
                    ? 'border-accent-500 bg-accent-500/10 text-surface-50'
                    : 'border-surface-800/60 text-surface-200 hover:border-surface-700 hover:bg-surface-850',
                )}
              >
                <span className="truncate">{c.name}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono cap-10 tabular-nums text-surface-500">
                    {formatCount(c.asset_count)}
                  </span>
                  {active ? <Check size={14} className="text-accent-400" /> : null}
                </span>
              </button>
            );
          })
        )}
      </div>

      {creating ? (
        <div className="flex gap-2">
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAdd();
              }
            }}
            placeholder="New collection name…"
            maxLength={120}
          />
          <Button variant="ghost" size="sm" onClick={() => setCreating(false)} disabled={pending}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="subtle"
          size="sm"
          className="self-start"
          onClick={() => {
            setCreating(true);
            setSelectedId(null);
          }}
        >
          <FolderPlus size={12} />
          Create new collection
        </Button>
      )}

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canSubmit || pending}
          onClick={() => void handleAdd()}
        >
          <Plus size={12} />
          {pending ? 'Adding…' : 'Add'}
        </Button>
      </DialogFooter>
    </>
  );
}
