import {
  Check,
  CircleSlash,
  Globe,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useViewStatus } from '@/components/layout/StatusBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toaster';
import { useHotkey } from '@/hooks/useHotkey';
import { trpc } from '@/ipc/trpc';
import { resolveThumbnail } from '@/lib/assetUrl';
import { cn } from '@/lib/cn';
import { formatBytes, formatCount, formatRating } from '@/lib/format';

/**
 * The Match queue — the screen the app was missing.
 *
 * Matching is the largest unfinished job in the library (2,453 packs deep) and
 * it had no home: `orbital.match` / `candidates` / `search` were live tRPC
 * procedures with no caller beyond a per-asset modal. 2,453 decisions made one
 * dialog at a time is not a workflow.
 *
 * The compare pane puts what is on disk beside what the scraper found, aligned
 * field by field, so accepting is a glance rather than an act of faith.
 *
 * Decisions persist. There are two of them, and they answer different
 * questions, so neither can be derived from the other:
 *
 *   R  reject this listing   the candidate is wrong; the pack stays queued and
 *                            the next candidate is offered instead
 *   D  dismiss this pack     nothing on Orbital is this; it leaves the queue
 *
 * Both survive a reload, and both survive a folder rename — the prune treats a
 * match decision as curation, like a tag.
 *
 * SCOPE — one piece of R1 is still absent. Bulk "accept all >= 92%" needs a
 * stored confidence, and confidence is computed per candidate on demand via a
 * rate-limited Orbital call, so there is nothing to threshold against without
 * first walking the whole queue.
 */

const PAGE_SIZE = 200;

/** Confidence bands, mirroring the matcher's MatchStrength. */
const STRENGTH_COLOR: Record<string, string> = {
  exact: 'text-success-500',
  high: 'text-success-500',
  medium: 'text-warning-300',
  low: 'text-danger-300',
  none: 'text-surface-400',
};

export function MatchView() {
  const utils = trpc.useUtils();
  const [cursor, setCursor] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const [manualQuery, setManualQuery] = useState('');
  const [manualOpen, setManualOpen] = useState(false);

  const filter = useMemo(
    () => ({
      asset_type: null,
      tags: null,
      name_search: null,
      is_favorite: null,
      scan_location_id: null,
      date_range: null,
      category: null,
      ecosystem: null,
      // Not 'unmatched': that is the Library sidebar's facet and must keep
      // counting packs the user dismissed, because they are still unmatched
      // DATA. This is queue membership, which dismissal removes.
      match_status: 'needs_review' as const,
    }),
    [],
  );

  const queue = trpc.assets.listCards.useQuery({ filter, sort: 'size_desc', limit: PAGE_SIZE });
  const total = trpc.assets.count.useQuery(filter);
  const stats = trpc.assets.stats.useQuery();

  // Biggest packs first: a 12 GB mystery folder is worth more of your attention
  // than a 40 MB one, so the queue pays for itself soonest at the top.
  const pending = queue.data ?? [];
  const current = pending[Math.min(cursor, Math.max(0, pending.length - 1))];

  const setViewStatus = useViewStatus((s) => s.setViewStatus);
  const resetViewStatus = useViewStatus((s) => s.resetViewStatus);
  useEffect(() => {
    setViewStatus({
      shown: total.data ?? null,
      selected: 0,
      viewMode: accepted > 0 ? `${formatCount(accepted)} accepted this session` : 'match queue',
    });
  }, [setViewStatus, total.data, accepted]);
  useEffect(() => resetViewStatus, [resetViewStatus]);

  const candidates = trpc.orbital.candidates.useQuery(
    { folderName: manualOpen && manualQuery ? manualQuery : (current?.name ?? ''), limit: 8 },
    { enabled: Boolean(current) },
  );

  const match = trpc.orbital.match.useMutation({
    onSuccess: () => {
      void utils.assets.invalidate();
      setAccepted((n) => n + 1);
      toast.success('Match accepted');
      setManualOpen(false);
      setManualQuery('');
    },
    onError: (err) => toast.error(err.message),
  });

  // Slugs this pack has already been offered and turned down. Fetched per
  // asset so a reject sticks across reloads instead of re-proposing the same
  // listing forever — matchAssetName is deterministic for a folder name, so
  // without this the top candidate never changes.
  const rejected = trpc.orbital.rejectedSlugs.useQuery(current?.id ?? 0, {
    enabled: Boolean(current),
  });
  const rejectedSet = useMemo(() => new Set(rejected.data ?? []), [rejected.data]);
  const best = candidates.data?.find((c) => !rejectedSet.has(c.item.slug));

  const onAccept = useCallback(() => {
    if (!current || !best || match.isPending) return;
    match.mutate({ assetId: current.id, slug: best.item.slug });
  }, [current, best, match]);

  const reject = trpc.orbital.reject.useMutation({
    onSuccess: () => {
      // Only the rejected-slug list changes; the queue is untouched because the
      // pack is still waiting for a match.
      void utils.orbital.rejectedSlugs.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const dismiss = trpc.orbital.dismiss.useMutation({
    onSuccess: () => {
      void utils.assets.invalidate();
      toast.success('Removed from the queue');
    },
    onError: (err) => toast.error(err.message),
  });

  /** "This listing is not this pack." Keeps the pack queued. */
  const onReject = useCallback(() => {
    if (!current || !best || reject.isPending) return;
    reject.mutate({ assetId: current.id, slug: best.item.slug });
  }, [current, best, reject]);

  /** "Nothing on Orbital is this pack." Takes it out of the queue. */
  const onDismiss = useCallback(() => {
    if (!current || dismiss.isPending) return;
    dismiss.mutate(current.id);
  }, [current, dismiss]);

  useHotkey({ key: 'a', handler: onAccept, enabled: Boolean(current && best) });
  useHotkey({ key: 's', handler: () => setManualOpen(true), enabled: Boolean(current) });
  useHotkey({ key: 'r', handler: onReject, enabled: Boolean(current && best) });
  useHotkey({ key: 'd', handler: onDismiss, enabled: Boolean(current) });

  if (queue.isPending) {
    return <Centered>Loading the queue…</Centered>;
  }
  if (!current) {
    return (
      <Centered>
        <Check size={28} className="text-success-500" />
        <p className="cap-14 text-surface-200">Nothing left to match in this batch.</p>
        <p className="cap-12 text-surface-400">
          {formatCount(stats.data?.needs_review ?? 0)} still to review ·{' '}
          {formatCount(stats.data?.unmatched ?? 0)} unmatched overall
        </p>
      </Centered>
    );
  }

  return (
    <div className="flex h-full w-full min-w-0">
      {/* Queue */}
      <aside className="flex w-[380px] shrink-0 flex-col border-r border-surface-800/60 bg-surface-935">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-surface-800/60 px-4">
          <span className="font-mono cap-11 uppercase tracking-[0.16em] text-surface-500">
            Needs match
          </span>
          <span className="ml-auto font-mono tabular-nums cap-12 text-surface-300">
            {formatCount(total.data ?? 0)}
          </span>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {pending.slice(0, 60).map((a, i) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setCursor(i)}
                className={cn(
                  'flex w-full items-center gap-3 border-b border-surface-800/40 px-4 py-3 text-left transition-colors',
                  a.id === current.id ? 'bg-accent-500/10' : 'hover:bg-surface-900/60',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'h-8 w-0.5 shrink-0 rounded-xs',
                    a.id === current.id ? 'bg-accent-500' : 'bg-transparent',
                  )}
                />
                <span className="min-w-0 flex-1 truncate cap-14 text-surface-100">{a.name}</span>
                <span className="shrink-0 font-mono tabular-nums cap-11 text-surface-400">
                  {formatBytes(a.file_size)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Compare */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-surface-800/60 px-5">
          <span className="min-w-0 truncate font-display cap-15 font-semibold text-surface-50">
            {current.name}
          </span>
          {candidates.isFetching ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-surface-400" />
          ) : best ? (
            <span
              className={cn(
                'shrink-0 rounded-sm bg-surface-900 px-2 py-0.5 font-mono cap-11 font-semibold',
                STRENGTH_COLOR[best.strength] ?? 'text-surface-400',
              )}
            >
              {Math.round(best.score * 100)}% · {best.strength}
            </span>
          ) : (
            <span className="shrink-0 font-mono cap-11 text-surface-400">no candidate</span>
          )}
          <span className="ml-auto shrink-0 font-mono tabular-nums cap-11 text-surface-500">
            {formatCount(cursor + 1)} of {formatCount(total.data ?? pending.length)}
          </span>
        </div>

        {/* minmax(0,1fr), not the grid-cols-2 default of minmax(auto,1fr):
            `auto` refuses to shrink below content, so a long marketplace title
            pushed the pane past the window instead of truncating. */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 overflow-y-auto p-6">
          <Pane
            icon={<HardDrive size={14} className="text-surface-400" />}
            title="On disk"
            tone="text-surface-400"
          >
            <Well thumb={resolveThumbnail(current)} />
            <Field label="Name" value={current.name} />
            <Field label="Size on disk" value={formatBytes(current.file_size)} />
            <Field label="Kind" value={current.asset_type ?? '—'} />
            <Field label="Added" value={current.created_date?.slice(0, 10) ?? '—'} />
            <Field label="Path" value={current.file_path ?? '—'} wrap />
          </Pane>

          <Pane
            icon={<Globe size={14} className="text-accent-400" />}
            title="Orbital candidate"
            tone="text-accent-400"
          >
            {candidates.isFetching ? (
              <div className="flex items-center gap-2 py-8 text-surface-400 cap-12">
                <Loader2 size={14} className="animate-spin" />
                Searching Orbital…
              </div>
            ) : best ? (
              <>
                <Well thumb={best.item.media?.images?.[0]?.url ?? null} />
                <Field label="Title" value={best.item.title} />
                <Field label="Seller" value={best.item.owner?.name ?? '—'} />
                <Field
                  label="Rating"
                  value={
                    best.item.rating?.average != null
                      ? `${formatRating(best.item.rating.average)} · ${formatCount(best.item.rating.count ?? 0)} reviews`
                      : '—'
                  }
                />
                <Field
                  label="Price"
                  value={best.item.price != null ? `$${best.item.price.toFixed(2)}` : '—'}
                />
                {candidates.data && candidates.data.length > 1 ? (
                  <p className="pt-1 font-mono cap-11 text-surface-500">
                    {formatCount(candidates.data.length - 1)} other candidate
                    {candidates.data.length === 2 ? '' : 's'} — use Search manually to pick another
                  </p>
                ) : null}
              </>
            ) : (
              <p className="py-8 cap-12 text-surface-400">
                No candidate found. Search manually, or skip.
              </p>
            )}
          </Pane>
        </div>

        {manualOpen ? (
          <ManualSearch
            assetId={current.id}
            initial={current.name}
            query={manualQuery}
            onQuery={setManualQuery}
            onClose={() => setManualOpen(false)}
            onPick={(slug) => match.mutate({ assetId: current.id, slug })}
            pending={match.isPending}
          />
        ) : null}

        <footer className="flex shrink-0 items-center gap-3 border-t border-surface-800/60 bg-surface-925 px-5 py-3">
          <Button
            variant="primary"
            size="md"
            onClick={onAccept}
            disabled={!best || match.isPending}
          >
            <Check size={14} />
            Accept match
          </Button>
          <Key>A</Key>
          <Button variant="outline" size="md" onClick={() => setManualOpen((v) => !v)}>
            <Search size={14} />
            Search manually
          </Button>
          <Key>S</Key>
          {/* Two verbs, not one. "Skip" used to mean both and remembered
              neither past a reload. */}
          <Button variant="ghost" size="md" onClick={onReject} disabled={!best}>
            <X size={14} />
            Not this one
          </Button>
          <Key>R</Key>
          <Button variant="ghost" size="md" onClick={onDismiss}>
            <CircleSlash size={14} />
            Not on Orbital
          </Button>
          <Key>D</Key>
          <span className="ml-auto font-mono cap-11 text-surface-500">
            {formatCount(accepted)} accepted this session
          </span>
        </footer>
      </section>
    </div>
  );
}

function ManualSearch({
  initial,
  query,
  onQuery,
  onClose,
  onPick,
  pending,
}: {
  readonly assetId: number;
  readonly initial: string;
  readonly query: string;
  readonly onQuery: (v: string) => void;
  readonly onClose: () => void;
  readonly onPick: (slug: string) => void;
  readonly pending: boolean;
}) {
  const [input, setInput] = useState(query || initial);
  useEffect(() => {
    const t = setTimeout(() => onQuery(input.trim()), 350);
    return () => clearTimeout(t);
  }, [input, onQuery]);

  const results = trpc.orbital.search.useQuery(
    { query: query || initial, limit: 8 },
    { enabled: (query || initial).length > 0 },
  );

  return (
    <div className="shrink-0 border-t border-surface-800/60 bg-surface-900 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Search size={13} className="text-surface-500" />
        <Input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search Orbital Market…"
          className="h-8 flex-1"
        />
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X size={13} />
        </Button>
      </div>
      {results.isFetching ? (
        <p className="cap-12 text-surface-400">Searching…</p>
      ) : (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {(results.data ?? []).map((item) => (
            <li key={item.slug}>
              <button
                type="button"
                disabled={pending}
                onClick={() => onPick(item.slug)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface-800 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate cap-14 text-surface-100">
                  {item.title}
                </span>
                <span className="shrink-0 cap-11 text-surface-400">
                  {item.owner?.name ?? 'Unknown'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Pane({
  icon,
  title,
  tone,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly tone: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        {icon}
        <span className={cn('font-mono cap-11 font-semibold uppercase tracking-[0.16em]', tone)}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function Well({ thumb }: { readonly thumb: string | null }) {
  if (!thumb) {
    return (
      <div className="flex aspect-video w-full items-center justify-center gap-2 rounded-md border border-surface-700 border-dashed bg-surface-925 text-surface-500">
        <ImageIcon size={18} />
        <span className="font-mono cap-11 uppercase tracking-[0.1em]">No thumbnail</span>
      </div>
    );
  }
  return (
    <img
      src={thumb}
      alt=""
      loading="lazy"
      className="aspect-video w-full rounded-md object-cover"
    />
  );
}

/** Same fixed-gutter definition row as the inspector — never justify-between. */
function Field({
  label,
  value,
  wrap,
}: {
  readonly label: string;
  readonly value: string;
  readonly wrap?: boolean;
}) {
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] items-baseline gap-3 border-b border-surface-800/40 py-2 font-mono">
      <span className="cap-11 uppercase tracking-[0.1em] text-surface-500">{label}</span>
      <span
        className={cn('min-w-0 cap-12 text-surface-100', wrap ? 'break-all' : 'truncate')}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Key({ children }: { readonly children: React.ReactNode }) {
  return <span className="-ml-1 mr-2 font-mono cap-11 text-surface-500">{children}</span>;
}

function Centered({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-surface-400">
      {children}
    </div>
  );
}
