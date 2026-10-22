import { Activity, FileArchive, FolderTree, ImageOff, type LucideIcon, Ruler } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { trpc } from '@/ipc/trpc';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';

type DiagnosticKind =
  | 'archive-only'
  | 'depth-limit-abandoned'
  | 'thumbnail-failed'
  | 'path-near-max-length';

interface KindMeta {
  readonly label: string;
  readonly icon: LucideIcon;
  /** What happened. */
  readonly cause: string;
  /** What the user can do about it. */
  readonly remedy: string;
}

const KINDS: Record<DiagnosticKind, KindMeta> = {
  'archive-only': {
    label: 'Archives not extracted',
    icon: FileArchive,
    cause: 'These folders hold only .rar/.zip/.7z files, so there is nothing to index inside them.',
    remedy: 'Extract them, then scan again.',
  },
  'depth-limit-abandoned': {
    label: 'Buried too deep',
    icon: FolderTree,
    cause: 'The pack finder hit its depth limit before reaching any content.',
    remedy: 'Flatten redundant wrapper folders (PackName\\PackName\\PackName), then scan again.',
  },
  'thumbnail-failed': {
    label: 'No thumbnail',
    icon: ImageOff,
    cause: 'The pack was indexed, but no preview image could be produced for its card.',
    remedy: 'Usually harmless — the card falls back to a folder icon.',
  },
  'path-near-max-length': {
    label: 'Paths near the length limit',
    icon: Ruler,
    cause: 'These packs contain paths close to the Windows 260-character MAX_PATH limit.',
    remedy: 'Move them closer to the drive root, or shorten the folder names.',
  },
};

const KIND_ORDER: readonly DiagnosticKind[] = [
  'archive-only',
  'depth-limit-abandoned',
  'thumbnail-failed',
  'path-near-max-length',
];

function openLocation(path: string) {
  void window.omnidex?.shell?.openFileLocation(path);
}

/**
 * Library Health — the account of what the last scan could NOT index.
 *
 * The point of this view is that a missing card and an empty folder used to
 * look identical. Every row here is something the scanner deliberately
 * skipped, paired with the reason and the fix.
 */
export function LibraryHealthView() {
  const [selected, setSelected] = useState<DiagnosticKind | null>(null);
  const summary = trpc.libraryHealth.summary.useQuery();
  const detail = trpc.libraryHealth.list.useQuery(
    { kind: selected ?? 'archive-only' },
    { enabled: selected !== null },
  );

  const counts = new Map<string, number>((summary.data ?? []).map((r) => [r.kind, r.count]));
  const total = (summary.data ?? []).reduce((sum, r) => sum + r.count, 0);
  const selectedMeta = selected ? KINDS[selected] : null;

  return (
    <div className="flex h-full w-full flex-col overflow-auto px-6 py-6">
      <PageHeader
        title="Library health"
        icon={Activity}
        description="What the last scan could not index, and why."
        actions={
          <Badge variant={total > 0 ? 'outline' : 'default'} className="font-mono tabular-nums">
            {formatCount(total)} skipped
          </Badge>
        }
      />

      {summary.isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-danger-500/40 bg-danger-500/5 py-16 text-center">
          <Activity size={32} strokeWidth={1.25} className="text-danger-500/70" />
          <p className="font-display cap-14 font-medium text-surface-200">
            Couldn't load diagnostics
          </p>
          <p className="max-w-md cap-12 text-surface-400">{summary.error.message}</p>
        </div>
      ) : total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-surface-800 bg-surface-900/30 py-16 text-center">
          <Activity size={32} strokeWidth={1.25} className="text-surface-600" />
          <p className="font-display cap-14 font-medium text-surface-200">Nothing skipped</p>
          <p className="max-w-md cap-12 text-surface-400">
            Either every folder in your scan locations was indexed, or no scan has run since this
            view was added. Run a scan to populate it.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {KIND_ORDER.map((kind) => {
              const meta = KINDS[kind];
              const Icon = meta.icon;
              const count = counts.get(kind) ?? 0;
              const active = selected === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={count === 0}
                  aria-pressed={active}
                  onClick={() => setSelected(active ? null : kind)}
                  className={cn(
                    'rounded-md border p-3 text-left transition-colors',
                    count === 0
                      ? 'cursor-default border-surface-800/40 bg-surface-900/20 opacity-50'
                      : 'cursor-pointer border-surface-800/60 bg-surface-900/40 hover:border-surface-700',
                    active && 'border-accent-500 bg-surface-900/70',
                  )}
                >
                  <div className="flex items-center gap-2 text-surface-400">
                    <Icon size={14} aria-hidden />
                    <span className="cap-11 uppercase tracking-wide">{meta.label}</span>
                  </div>
                  <div className="mt-2 font-mono cap-23 font-semibold tabular-nums text-surface-50">
                    {formatCount(count)}
                  </div>
                  <p className="mt-1 cap-11 text-surface-500">{meta.cause}</p>
                </button>
              );
            })}
          </div>

          {selected && selectedMeta ? (
            <section className="mt-6 min-w-0">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h2 className="font-display cap-14 font-medium text-surface-100">
                  {selectedMeta.label}
                </h2>
                <p className="cap-11 text-surface-400">{selectedMeta.remedy}</p>
              </div>
              {detail.isLoading ? (
                <p className="cap-12 text-surface-400">Loading…</p>
              ) : (
                <ul className="divide-y divide-surface-800/60 overflow-hidden rounded-md border border-surface-800/60">
                  {(detail.data ?? []).map((row) => (
                    <li key={row.id} className="min-w-0">
                      <button
                        type="button"
                        onClick={() => openLocation(row.path)}
                        title="Open in file explorer"
                        className="w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-surface-900/60"
                      >
                        <p className="truncate font-mono cap-11 text-surface-200">{row.path}</p>
                        <p className="truncate cap-11 text-surface-500">{row.detail}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {/* ponytail: the repo caps the drill-down at 500 rows. Say so
                  rather than paginating — the list is for spot-checking, and
                  the count on the card above is the real number. */}
              {(detail.data?.length ?? 0) >= 500 ? (
                <p className="mt-2 cap-11 text-surface-500">
                  Showing the first 500 of {formatCount(counts.get(selected) ?? 0)}.
                </p>
              ) : null}
            </section>
          ) : (
            <p className="mt-6 cap-12 text-surface-500">Select a category to see the paths.</p>
          )}
        </>
      )}
    </div>
  );
}
