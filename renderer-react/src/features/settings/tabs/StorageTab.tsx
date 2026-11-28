import { Check, ClipboardCopy, FolderOpen, Trash2 } from 'lucide-react';
import { type ReactNode, version as reactVersion, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toaster';
import { trpc } from '@/ipc/trpc';
import { formatBytes, formatCount } from '@/lib/format';
import { useRuntime } from '@/runtime/useRuntime';
import { useModals } from '@/stores/modals';

/**
 * Where the library lives and what it costs on disk.
 *
 * The six build-metadata rows this tab used to render (React / Electron /
 * Chrome / Node / platform / runtime) were a readout nobody could act on; they
 * now live behind one "Copy diagnostics" button, which is the only thing anyone
 * ever wanted them for.
 */
export function StorageTab() {
  const runtime = useRuntime();
  const utils = trpc.useUtils();
  const openConfirm = useModals((s) => s.openConfirm);

  const storage = trpc.settings.storage.useQuery();
  const locations = trpc.scanLocations.list.useQuery();
  const locationStats = trpc.scanLocations.stats.useQuery();
  const stats = trpc.assets.stats.useQuery();

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(t);
  }, [copied]);

  const purge = trpc.settings.purgeThumbnails.useMutation({
    onSuccess: (result) => {
      void utils.settings.storage.invalidate();
      void utils.assets.invalidate();
      toast.success(
        `Purged ${formatCount(result.removed)} thumbnails · ${formatBytes(result.freedBytes)} freed`,
        { description: 'They regenerate the next time these folders are scanned.' },
      );
    },
    onError: (err) => toast.error(err.message),
  });

  const openLogFolder = trpc.settings.openLogFolder.useMutation({
    onSuccess: (result) => {
      if (!result.ok) toast.error(result.error ?? 'Could not open the log folder');
    },
    onError: (err) => toast.error(err.message),
  });

  // Biggest consumer first — the only ordering that answers "what is eating
  // the drive". Locations that have produced nothing are still listed, because
  // a folder indexing zero packs is itself the finding.
  const byLocation = (locations.data ?? [])
    .map((loc) => {
      const s = (locationStats.data ?? []).find((row) => row.scan_location_id === loc.id);
      return {
        key: loc.id ?? loc.path,
        name: loc.name,
        assetCount: s?.asset_count ?? 0,
        sizeBytes: s?.size_bytes ?? 0,
        isPartial: (s?.partial_count ?? 0) > 0,
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  async function copyDiagnostics() {
    const s = storage.data;
    const lib = stats.data;
    const lines = [
      'Omnidex diagnostics',
      `Frontend      React ${reactVersion}`,
      `Runtime       ${runtime.kind}`,
      `Platform      ${runtime.platform}`,
      `Electron      ${runtime.versions.electron ?? 'n/a'}`,
      `Chrome        ${runtime.versions.chrome ?? 'n/a'}`,
      `Node          ${runtime.versions.node ?? 'n/a'}`,
      s ? `Database      ${s.dbPath} (${formatBytes(s.dbBytes)})` : 'Database      unavailable',
      s
        ? `Thumbnails    ${s.thumbnailsPath} (${formatCount(s.thumbnailCount)} files, ${formatBytes(s.thumbnailBytes)})`
        : 'Thumbnails    unavailable',
      s ? `Logs          ${s.logPath ?? 'not initialized'} (${formatBytes(s.logBytes)})` : '',
      s ? `App data      ${s.userDataPath}` : '',
      lib
        ? `Library       ${formatCount(lib.total)} packs, ${formatCount(lib.unmatched)} unmatched, ${formatBytes(lib.size_bytes)}`
        : '',
    ].filter(Boolean);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      toast.success('Diagnostics copied');
    } catch {
      toast.error('Could not write to the clipboard');
    }
  }

  function confirmPurge() {
    openConfirm({
      title: 'Purge thumbnail cache?',
      body: (
        <>
          Delete every extracted thumbnail
          {storage.data ? (
            <>
              {' '}
              <span className="font-mono text-surface-100">
                ({formatCount(storage.data.thumbnailCount)} files,{' '}
                {formatBytes(storage.data.thumbnailBytes)})
              </span>
            </>
          ) : null}
          . Your assets are untouched — thumbnails regenerate the next time each folder is scanned.
        </>
      ),
      confirmLabel: 'Purge',
      destructive: true,
      onConfirm: async () => {
        await purge.mutateAsync();
      },
    });
  }

  const s = storage.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Storage</CardTitle>
            <CardDescription>What Omnidex keeps on this machine.</CardDescription>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void copyDiagnostics()}>
            {copied ? <Check size={12} /> : <ClipboardCopy size={12} />}
            {copied ? 'Copied' : 'Copy diagnostics'}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {storage.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <StorageRow
                label="Database"
                path={s?.dbPath ?? null}
                value={formatBytes(s?.dbBytes ?? 0)}
              />
              <StorageRow
                label="Thumbnail cache"
                path={s?.thumbnailsPath ?? null}
                value={`${formatCount(s?.thumbnailCount ?? 0)} files · ${formatBytes(s?.thumbnailBytes ?? 0)}`}
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={confirmPurge}
                    disabled={purge.isPending || (s?.thumbnailCount ?? 0) === 0}
                  >
                    <Trash2 size={12} />
                    {purge.isPending ? 'Purging…' : 'Purge'}
                  </Button>
                }
              />
              <StorageRow
                label="Logs"
                path={s?.logPath ?? null}
                value={formatBytes(s?.logBytes ?? 0)}
                action={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openLogFolder.mutate()}
                    disabled={openLogFolder.isPending || !s?.logPath}
                  >
                    <FolderOpen size={12} />
                    Open log folder
                  </Button>
                }
              />
              <StorageRow label="App data" path={s?.userDataPath ?? null} value="" />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Library on disk</CardTitle>
          <CardDescription>
            Indexed bytes per folder, largest first. Sizes are what the walker measured, not what
            Omnidex stores.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {locations.isPending || locationStats.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : byLocation.length === 0 ? (
            <p className="cap-12 text-surface-400">No folders yet.</p>
          ) : (
            <>
              {byLocation.map((row) => (
                <div
                  key={row.key}
                  className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-surface-800/60 py-1 last:border-0"
                >
                  <span className="truncate cap-12 text-surface-200">{row.name}</span>
                  <span className="shrink-0 font-mono cap-11 tabular-nums text-surface-400">
                    {formatCount(row.assetCount)} assets ·{' '}
                    <span className="text-surface-100">
                      {formatBytes(row.sizeBytes, row.isPartial)}
                    </span>
                  </span>
                </div>
              ))}
              <div className="grid grid-cols-[1fr_auto] items-baseline gap-4 pt-1">
                <span className="font-mono cap-10 uppercase tracking-[0.14em] text-surface-500">
                  Total
                </span>
                <span className="shrink-0 font-mono cap-11 font-semibold tabular-nums text-surface-50">
                  {formatBytes(byLocation.reduce((sum, r) => sum + r.sizeBytes, 0))}
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StorageRow({
  label,
  path,
  value,
  action,
}: {
  readonly label: string;
  readonly path: string | null;
  readonly value: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-surface-800/60 pb-3 last:border-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="cap-12 text-surface-200">{label}</span>
          {value ? (
            <span className="font-mono cap-11 tabular-nums text-surface-100">{value}</span>
          ) : null}
        </div>
        <span className="truncate font-mono cap-10 text-surface-500">{path ?? 'unavailable'}</span>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
