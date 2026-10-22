import type { ScanLocation } from '@omnidex/types/db';
import { Folder, FolderPlus, MoreVertical, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toaster';
import { EditLocationModal } from '@/features/locations/EditLocationModal';
import { type ActionProgressState, useActionProgress } from '@/hooks/useActionProgress';
import { trpc } from '@/ipc/trpc';
import { formatBytes, formatCount } from '@/lib/format';
import { useModals } from '@/stores/modals';
import { LibrarySummary } from './LibrarySummary';

export function AssetSourcesTab() {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ScanLocation | null>(null);
  const openConfirm = useModals((s) => s.openConfirm);
  const utils = trpc.useUtils();

  const locations = trpc.scanLocations.list.useQuery();
  const stats = trpc.scanLocations.stats.useQuery();
  const activeCount = trpc.scanner.activeCount.useQuery(undefined, { refetchInterval: 2_000 });

  // Live scan progress, rendered in the row that started it (see handleScanNow).
  const { scan } = useActionProgress();

  const setActive = trpc.scanLocations.setActive.useMutation({
    onSuccess: () => utils.scanLocations.list.invalidate(),
    onError: (err) => toast.error(err.message),
  });

  const invalidateAfterScan = () => {
    utils.assets.invalidate();
    utils.scanLocations.list.invalidate();
    utils.scanLocations.stats.invalidate();
  };

  const refreshOne = trpc.scanner.refreshOne.useMutation({
    onSuccess: invalidateAfterScan,
    onError: (err) => toast.error(err.message),
  });

  // Sweep every active folder. Same service + progress transport as the
  // per-location "Scan" button and the Command Palette's refreshAll — this just
  // surfaces it as a visible control (the palette is keyboard-only).
  const refreshAll = trpc.scanner.refreshAll.useMutation({
    onSuccess: invalidateAfterScan,
    onError: (err) => toast.error(err.message),
  });

  const deleteLocation = trpc.scanLocations.delete.useMutation({
    onSuccess: () => {
      utils.scanLocations.list.invalidate();
      utils.scanLocations.stats.invalidate();
      utils.assets.invalidate();
      toast.success('Folder removed');
    },
    onError: (err) => toast.error(err.message),
  });

  const data = locations.data ?? [];
  const statsById = new Map((stats.data ?? []).map((s) => [s.scan_location_id, s]));
  const anyScanRunning =
    (activeCount.data ?? 0) > 0 || refreshOne.isPending || refreshAll.isPending;
  const hasActiveLocation = data.some((loc) => loc.is_active);

  // Settings stays open. It used to close so the floating ScanProgressPanel
  // wouldn't sit under the dialog overlay — which threw away the user's place
  // to solve a z-index problem. Progress now renders in the row that started
  // the scan; the floating panel still covers scans started from anywhere else.
  function handleScanNow(loc: ScanLocation) {
    if (loc.id == null) return;
    toast.success(`Scanning ${loc.name}`);
    refreshOne.mutate(loc.id);
  }

  function handleScanAll() {
    toast.success('Scanning all folders');
    refreshAll.mutate();
  }

  function handleDelete(loc: ScanLocation) {
    if (loc.id == null) return;
    const id = loc.id;
    openConfirm({
      title: 'Remove folder?',
      body: (
        <>
          Remove <span className="font-medium text-surface-100">{loc.name}</span> from your scan
          locations? Indexed assets stay in the library; the folder just won&apos;t be scanned
          again.
        </>
      ),
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: async () => {
        await deleteLocation.mutateAsync(id);
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <EditLocationModal open={addOpen} onOpenChange={setAddOpen} />
      <EditLocationModal
        open={editing != null}
        location={editing}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
      />

      <LibrarySummary />

      <div className="flex items-center justify-between">
        <h2 className="font-display cap-14 font-semibold text-surface-100">Scan locations</h2>
        <div className="flex items-center gap-2">
          {hasActiveLocation ? (
            <Button size="sm" variant="secondary" disabled={anyScanRunning} onClick={handleScanAll}>
              <RefreshCw size={12} />
              {anyScanRunning ? 'Scanning…' : 'Scan all'}
            </Button>
          ) : null}
          <Button size="sm" variant="primary" onClick={() => setAddOpen(true)}>
            <FolderPlus size={12} />
            Add folder
          </Button>
        </div>
      </div>

      {locations.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : data.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-surface-800 py-10 text-center text-surface-400">
          <Folder size={24} strokeWidth={1.2} />
          <p className="cap-12">No folders yet. Add one to start indexing.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.map((loc) => (
            <LocationRow
              key={loc.id ?? loc.path}
              location={loc}
              // `undefined` while the aggregate is in flight, `null` once it
              // has resolved and this folder produced nothing.
              stats={stats.isSuccess ? (statsById.get(loc.id ?? -1) ?? null) : undefined}
              progress={scan && loc.id != null && scan.locationId === loc.id ? scan : null}
              scanning={anyScanRunning}
              onScan={() => handleScanNow(loc)}
              onToggle={(checked) => {
                if (loc.id != null) setActive.mutate({ id: loc.id, is_active: checked });
              }}
              onEdit={() => setEditing(loc)}
              onDelete={() => handleDelete(loc)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface LocationStats {
  readonly asset_count: number;
  readonly size_bytes: number;
  readonly partial_count: number;
  readonly last_scan: string | null;
}

interface LocationRowProps {
  readonly location: ScanLocation;
  readonly stats: LocationStats | null | undefined;
  readonly progress: ActionProgressState | null;
  readonly scanning: boolean;
  readonly onScan: () => void;
  readonly onToggle: (checked: boolean) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

function LocationRow({
  location,
  stats,
  progress,
  scanning,
  onScan,
  onToggle,
  onEdit,
  onDelete,
}: LocationRowProps) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-surface-800/60 bg-surface-900/40 px-3 py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Folder size={14} className="shrink-0 text-surface-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate cap-14 font-medium text-surface-100">{location.name}</div>
            <div className="truncate font-mono cap-10 text-surface-400">{location.path}</div>
          </div>
        </div>

        {/* What this folder actually produced. A folder that has never been
            scanned says so rather than showing "0 assets" — never-looked-up and
            looked-up-and-found-nothing are different claims. */}
        <div className="hidden shrink-0 flex-col items-end gap-0.5 font-mono cap-10 tabular-nums text-surface-400 sm:flex">
          {stats === undefined ? (
            <Skeleton className="h-3 w-32" />
          ) : stats === null ? (
            <span className="text-surface-500">Never scanned</span>
          ) : (
            <>
              <span>
                {formatCount(stats.asset_count)} assets ·{' '}
                {formatBytes(stats.size_bytes, stats.partial_count > 0)}
              </span>
              <span className="text-surface-500">{formatScannedAt(stats.last_scan)}</span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Labelled, not a Power glyph: the icon read as "turn this off"
              sitting beside the toggle that actually does that. */}
          <Button size="sm" variant="ghost" disabled={scanning} onClick={onScan}>
            {progress?.active ? 'Scanning…' : 'Scan'}
          </Button>
          <Switch
            aria-label={`Index ${location.name}`}
            checked={location.is_active}
            onCheckedChange={onToggle}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <MoreVertical size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil size={12} />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-danger-500 focus:text-danger-500 [&_svg]:text-danger-500"
                onSelect={onDelete}
              >
                <Trash2 size={12} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {progress ? (
        <div className="flex flex-col gap-1" aria-live="polite">
          <Progress value={progress.percent} />
          <div className="flex items-center justify-between font-mono cap-10 tabular-nums text-surface-400">
            <span className="truncate pr-2">
              {progress.phase === 'done'
                ? 'Done'
                : progress.phase === 'error'
                  ? (progress.message ?? 'Failed')
                  : (progress.currentName ?? 'Working…')}
            </span>
            <span className="shrink-0">
              {formatCount(progress.processed)} / {formatCount(progress.total)}
            </span>
          </div>
        </div>
      ) : null}
    </li>
  );
}

const RELATIVE_FMT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Scanned 3 hours ago". Falls back to an absolute date past a week. */
function formatScannedAt(iso: string | null): string {
  if (!iso) return 'Never scanned';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'Never scanned';
  const elapsed = Date.now() - then;
  const ago = (unit: Intl.RelativeTimeFormatUnit, ms: number) =>
    RELATIVE_FMT.format(-Math.floor(elapsed / ms), unit);
  if (elapsed < MINUTE) return 'Scanned just now';
  if (elapsed < HOUR) return `Scanned ${ago('minute', MINUTE)}`;
  if (elapsed < DAY) return `Scanned ${ago('hour', HOUR)}`;
  if (elapsed < 7 * DAY) return `Scanned ${ago('day', DAY)}`;
  return `Scanned ${new Date(then).toLocaleDateString()}`;
}
