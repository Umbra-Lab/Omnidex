import { Image as ImageIcon, Loader2, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { trpc } from '@/ipc/trpc';
import { formatRating } from '@/lib/format';

interface MatchPickerModalProps {
  readonly assetId: number;
  readonly assetName: string;
  readonly currentSlug?: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

// Match-strength band → badge color. Mirrors the matcher's `MatchStrength`.
const STRENGTH_VARIANT: Record<string, 'success' | 'accent' | 'outline'> = {
  exact: 'success',
  high: 'success',
  medium: 'accent',
  low: 'outline',
  none: 'outline',
};

/**
 * Per-asset Orbital match correction. Seeds the search with the asset's name and
 * ranks candidates via `orbital.candidates` (editable to re-search anything);
 * picking one calls `orbital.match` with that product slug, which enriches the
 * asset's metadata/gallery/link. Closes the last "backend wired, no UI" gap.
 */
export function MatchPickerModal({
  assetId,
  assetName,
  currentSlug,
  open,
  onOpenChange,
}: MatchPickerModalProps) {
  const utils = trpc.useUtils();
  const [input, setInput] = useState(assetName);
  const [queryText, setQueryText] = useState(assetName);

  // Reset the search to the asset name every time the modal (re)opens.
  useEffect(() => {
    if (open) {
      setInput(assetName);
      setQueryText(assetName);
    }
  }, [open, assetName]);

  // Debounce typing — one Orbital call per keystroke would hammer the API.
  useEffect(() => {
    const t = setTimeout(() => setQueryText(input.trim()), 350);
    return () => clearTimeout(t);
  }, [input]);

  const candidates = trpc.orbital.candidates.useQuery(
    { folderName: queryText, limit: 12 },
    { enabled: open && queryText.length > 0 },
  );

  const match = trpc.orbital.match.useMutation({
    onSuccess: () => {
      void utils.assets.get.invalidate(assetId);
      void utils.assets.listCards.invalidate();
      toast.success('Marketplace match updated');
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const results = candidates.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Match marketplace listing</DialogTitle>
          <DialogDescription>
            Pick the Orbital Market product for{' '}
            <span className="text-surface-100">{assetName}</span>. Its metadata, gallery, and link
            are pulled from your choice.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            size={13}
            className="-translate-y-1/2 absolute top-1/2 left-2.5 text-surface-500"
          />
          <Input
            // Focus the search on open — it's the modal's sole action.
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search Orbital Market…"
            className="pl-8"
          />
        </div>

        <div className="-mx-1 max-h-[360px] overflow-y-auto overflow-x-hidden px-1">
          {candidates.isFetching ? (
            <div className="flex items-center justify-center gap-2 py-10 text-surface-400">
              <Loader2 size={14} className="animate-spin" />
              <span className="cap-12">Searching…</span>
            </div>
          ) : candidates.isError ? (
            <div className="py-10 text-center text-danger-400 cap-12">
              Couldn&apos;t reach Orbital Market. Check your connection and try again.
            </div>
          ) : results.length === 0 ? (
            <div className="py-10 text-center text-surface-400 cap-12">
              {queryText ? 'No matches found. Try a different search.' : 'Type to search.'}
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {results.map(({ item, score, strength }) => {
                const thumb = item.media?.images?.[0]?.url ?? null;
                const isCurrent = currentSlug != null && item.slug === currentSlug;
                const pending = match.isPending && match.variables?.slug === item.slug;
                // search.ts normalizes price/rating to numbers at the API boundary
                // (single source of truth), so `?? NaN` only guards a real null.
                const price = item.price ?? Number.NaN;
                const rating = item.rating?.average ?? Number.NaN;
                const seller = item.owner?.name ?? 'Unknown seller';
                return (
                  <li key={item.slug}>
                    <button
                      type="button"
                      disabled={match.isPending}
                      aria-busy={pending}
                      aria-label={`Match to ${item.title} by ${seller}${isCurrent ? ' (current match)' : ''}`}
                      onClick={() => match.mutate({ assetId, slug: item.slug })}
                      className="group flex w-full items-center gap-3 rounded-md border border-surface-800/60 bg-surface-900/40 p-2 text-left transition-colors hover:border-surface-700 hover:bg-surface-900 disabled:opacity-60"
                    >
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-800 text-surface-500">
                        {thumb ? (
                          <img
                            src={thumb}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <ImageIcon size={16} strokeWidth={1.5} aria-hidden />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate cap-14 font-medium text-surface-100">
                            {item.title}
                          </span>
                          {isCurrent ? <Badge variant="outline">Current</Badge> : null}
                        </div>
                        <div className="truncate font-mono cap-10 tabular-nums text-surface-400">
                          {seller}
                          {Number.isFinite(rating) ? ` · ★ ${formatRating(rating)}` : ''}
                          {Number.isFinite(price) ? ` · $${price.toFixed(2)}` : ''}
                        </div>
                      </div>
                      <Badge variant={STRENGTH_VARIANT[strength] ?? 'outline'}>
                        {pending ? '…' : `${Math.round(score * 100)}%`}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
