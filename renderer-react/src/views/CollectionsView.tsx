import { useNavigate } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { GridErrorState } from '@/components/GridErrorState';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toaster';
import { trpc } from '@/ipc/trpc';
import { resolveThumbnail } from '@/lib/assetUrl';
import { formatBytes, formatCount } from '@/lib/format';
import { useModals } from '@/stores/modals';

export function CollectionsView() {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const openConfirm = useModals((s) => s.openConfirm);
  const collections = trpc.collections.list.useQuery();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = trpc.collections.create.useMutation({
    onSuccess: () => {
      toast.success(`Created collection "${name}"`);
      setName('');
      setDescription('');
      setOpen(false);
      void utils.collections.list.invalidate();
    },
    onError: (err) => {
      toast.error(`Couldn't create collection: ${err.message}`);
    },
  });

  const remove = trpc.collections.delete.useMutation({
    onSuccess: () => {
      void utils.collections.list.invalidate();
    },
  });

  const onDelete = (id: number, label: string) => {
    openConfirm({
      title: 'Delete collection?',
      body: `"${label}" will be deleted. The assets inside stay in your library.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await remove.mutateAsync(id);
        toast.success('Collection deleted');
      },
    });
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate({
      name: trimmed,
      description: description.trim() || null,
      color: null,
      icon: null,
      is_smart: null,
      smart_filter: null,
    });
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-auto px-6 py-6">
      <PageHeader
        title="Collections"
        description="Hand-picked bundles of assets."
        actions={
          <Button variant="primary" size="md" onClick={() => setOpen(true)}>
            <Plus size={14} />
            New collection
          </Button>
        }
      />

      {collections.isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholders
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : collections.isError ? (
        <GridErrorState
          message={collections.error.message}
          onRetry={() => void collections.refetch()}
        />
      ) : !collections.data || collections.data.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-surface-800 bg-surface-900/30 py-16 text-center">
          <p className="font-display cap-14 font-medium text-surface-200">No collections yet</p>
          <p className="max-w-xs cap-12 text-surface-400">
            Group assets by project, theme, or workflow. Start with favorites and refine.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <Plus size={12} />
            Create one
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {collections.data.map((c) => {
            const goDetail = () => {
              if (c.id == null) return;
              void navigate({
                to: '/collections/$collectionId',
                params: { collectionId: String(c.id) },
              });
            };
            return (
              // The primary "open collection" affordance is a real <button> that
              // fills the card (stretched-link pattern). The delete <button> is a
              // sibling stacked above it — keeping both as genuine, keyboard-
              // operable buttons without nesting one inside the other.
              <Card
                key={c.id ?? c.name}
                className="group relative transition-colors hover:border-surface-700 focus-within:border-accent-500"
              >
                <button
                  type="button"
                  onClick={goDetail}
                  aria-label={`Open collection ${c.name}`}
                  className="absolute inset-0 z-0 rounded-md focus-visible:outline-none"
                />
                <div className="pointer-events-none relative z-10">
                  <CoverMosaic covers={c.covers} />
                  <CardHeader>
                    {/* One count, once. The title used to right-align the
                        number and CardContent then repeated it as "N assets",
                        with an empty row between — the card read as broken. */}
                    <CardTitle className="truncate">{c.name}</CardTitle>
                    {c.description ? (
                      <CardDescription className="line-clamp-2">{c.description}</CardDescription>
                    ) : null}
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <span className="font-mono cap-11 tabular-nums text-surface-400">
                      {formatCount(c.asset_count)} asset{c.asset_count === 1 ? '' : 's'}
                      {c.size_bytes > 0 ? ` · ${formatBytes(c.size_bytes)}` : ''}
                    </span>
                    {c.id != null ? (
                      <button
                        type="button"
                        aria-label={`Delete collection ${c.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(c.id as number, c.name);
                        }}
                        className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md text-surface-500 opacity-0 transition-all hover:bg-danger-500/10 hover:text-danger-400 focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    ) : null}
                  </CardContent>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New collection</DialogTitle>
            <DialogDescription>
              Bundle assets together for a project, theme, or workflow.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="collection-name">Name</Label>
              <Input
                id="collection-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sci-fi environment kit"
                maxLength={120}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="collection-description">Description (optional)</Label>
              <Input
                id="collection-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short note about what goes in here"
                maxLength={400}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={create.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={create.isPending || !name.trim()}
              >
                {create.isPending ? 'Creating…' : 'Create collection'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 2x2 mosaic from the four most recently added members.
 *
 * A collection is a curated set of 3D content and its card was a name, a
 * number and a border — no cover, no colour, no icon, in an app for visual
 * artists. Falls back to a flat surface when no member has a thumbnail yet,
 * which is honest rather than showing a placeholder that implies a missing
 * image.
 */
function CoverMosaic({ covers }: { readonly covers: string | null }) {
  const urls = useMemo(() => {
    if (!covers) return [] as string[];
    try {
      const parsed = JSON.parse(covers) as unknown;
      if (!Array.isArray(parsed)) return [] as string[];
      return parsed
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .map((v) => resolveThumbnail({ thumbnail_path: v, orbital_thumbnail_url: null }))
        .filter((v): v is string => Boolean(v))
        .slice(0, 4);
    } catch {
      return [] as string[];
    }
  }, [covers]);

  if (urls.length === 0) {
    return <div className="h-20 w-full rounded-t-md bg-surface-900" />;
  }

  return (
    <div className="grid h-20 w-full grid-cols-2 grid-rows-2 gap-px overflow-hidden rounded-t-md bg-surface-800">
      {Array.from({ length: 4 }).map((_, i) => {
        const url = urls[i % urls.length];
        return (
          <img
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed 4-cell mosaic, index IS the cell
            key={i}
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        );
      })}
    </div>
  );
}
