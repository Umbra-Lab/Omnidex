import type { Asset } from '@omnidex/types/db';
import { ExternalLink, Folder, RefreshCw, Wand2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { trpc } from '@/ipc/trpc';
import { formatSupportedVersions, formatTaxonomyLabel } from '@/lib/format';

const fieldLabel = 'font-mono cap-10 uppercase tracking-[0.14em] text-surface-300';

export function InspectorReadout({
  asset,
  hasMatch,
  onMatch,
}: {
  readonly asset: Asset;
  readonly hasMatch: boolean;
  readonly onMatch: () => void;
}) {
  const utils = trpc.useUtils();
  const locations = trpc.scanLocations.list.useQuery();
  const location = locations.data?.find((entry) => entry.id === asset.scan_location_id);
  const [failedOpen, setFailedOpen] = useState<{ path: string; modifiedDate: string } | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const recoveryId = useId();

  const rescan = trpc.scanner.refreshOne.useMutation({
    onSettled: async () => {
      await Promise.all([
        utils.assets.invalidate(),
        utils.collections.assets.invalidate(),
        utils.scanLocations.list.invalidate(),
        utils.scanLocations.stats.invalidate(),
      ]);
    },
  });

  const path = asset.file_path?.trim() ? asset.file_path : null;
  const missingSince = path ? asset.missing_since : null;
  // Scanning the same path advances modified_date. A failed shell attempt
  // stays relevant until the scanner actually sees this pack again.
  const folderUnavailable =
    failedOpen != null &&
    failedOpen.path === path &&
    failedOpen.modifiedDate === asset.modified_date;
  const canOpenFolder = path != null && !missingSince && !folderUnavailable;
  const canRescan =
    path != null && !canOpenFolder && location?.is_active && asset.scan_location_id > 0;
  const hasFolderAction = canOpenFolder || canRescan;
  const listing = asset.orbital_source_url;
  const versions = formatSupportedVersions(asset.orbital_supported_versions);
  const ecosystem = formatTaxonomyLabel(asset.asset_ecosystem ?? asset.ecosystem);

  const folderStatus = !path
    ? 'No local path recorded'
    : missingSince
      ? 'Missing since'
      : folderUnavailable
        ? 'Folder unavailable'
        : 'Path recorded';
  const recovery = !path
    ? 'You can still organize this asset.'
    : canOpenFolder
      ? null
      : canRescan
        ? 'Reconnect the drive or restore the pack to its recorded path, then rescan.'
        : 'Check the scan location in Settings → Folders.';

  async function openTarget(target: 'folder' | 'listing') {
    const value = target === 'folder' ? path : listing;
    if (!value || (target === 'folder' && !canOpenFolder)) return;
    const message =
      target === 'folder' ? "Couldn't open the asset folder" : "Couldn't open the listing";
    try {
      const shell = window.omnidex?.shell;
      const result = await (target === 'folder'
        ? shell?.openFileLocation(value)
        : shell?.openExternal(value));
      if (result?.ok) return;
      if (target === 'folder' && result?.error === 'not found') {
        setFailedOpen({ path: value, modifiedDate: asset.modified_date });
        return;
      }
      toast.error(`${message}. ${result?.error ?? 'Desktop shell unavailable.'}`);
    } catch {
      toast.error(`${message}. Please try again.`);
    }
  }

  async function rescanFolder() {
    if (!canRescan || rescan.isPending) return;
    setScanMessage(null);
    const scanFailed = 'Could not scan this folder. Check that it is accessible and try again.';
    try {
      const result = await rescan.mutateAsync(asset.scan_location_id);
      if (result.error === 'already running') {
        setScanMessage('A scan is already running for this folder.');
      } else if (!result.completed_successfully || result.error) {
        setScanMessage(result.error === 'Scan canceled' ? 'Scan canceled.' : scanFailed);
      }
    } catch {
      setScanMessage(scanFailed);
    }
  }

  return (
    <section
      aria-label="Asset status"
      className="min-w-0 divide-y divide-surface-800 rounded-md border border-surface-800 bg-surface-925"
    >
      <div className="px-3 py-2.5">
        <p className={fieldLabel}>Local copy</p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="min-w-0" aria-live="polite">
            <p
              className={`break-words cap-13 font-semibold ${path && !canOpenFolder ? 'text-warning-300' : 'text-surface-50'}`}
            >
              {folderStatus}
            </p>
            {missingSince ? (
              <time
                className="mt-1 block whitespace-nowrap font-mono cap-11 tabular-nums text-warning-300"
                dateTime={missingSince.slice(0, 10)}
              >
                {missingSince.slice(0, 10)}
              </time>
            ) : null}
            {location?.name ? (
              <p className="mt-1 break-words cap-11 text-surface-300">{location.name}</p>
            ) : null}
          </div>
          <Button
            variant={hasFolderAction ? 'primary' : 'outline'}
            size="sm"
            className="shrink-0 aria-disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-accent-400"
            disabled={!hasFolderAction}
            aria-disabled={rescan.isPending || undefined}
            aria-describedby={recovery ? recoveryId : undefined}
            onClick={() => {
              if (rescan.isPending) return;
              if (canRescan) void rescanFolder();
              else void openTarget('folder');
            }}
          >
            {canRescan || rescan.isPending ? <RefreshCw size={12} /> : <Folder size={12} />}
            {rescan.isPending ? 'Scanning…' : canRescan ? 'Rescan folder' : 'Open folder'}
          </Button>
        </div>
        {recovery ? (
          <p id={recoveryId} className="mt-2 cap-12-prose text-surface-300">
            {recovery}
          </p>
        ) : null}
        <output className="block">
          {scanMessage && !canOpenFolder ? (
            <span className="mt-2 block cap-12-prose text-warning-300">{scanMessage}</span>
          ) : null}
        </output>
      </div>
      <dl className="grid grid-cols-2 gap-3 px-3 py-2.5">
        <div className="min-w-0">
          <dt className={fieldLabel}>Ecosystem</dt>
          <dd className="mt-2 break-words cap-12 font-medium text-surface-100">{ecosystem}</dd>
        </div>
        <div className="min-w-0">
          <dt className={fieldLabel}>Listing versions</dt>
          <dd className="mt-2 break-words font-mono cap-11 tabular-nums text-surface-100">
            {versions === '—' ? 'Not recorded' : versions}
          </dd>
        </div>
      </dl>
      <div className="px-3 py-2.5">
        <p className={fieldLabel}>Marketplace</p>
        <p className="mt-2 cap-12 text-surface-200">
          {hasMatch || listing ? 'Listing recorded' : 'Not matched to a marketplace listing'}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {listing ? (
            <Button
              variant={hasFolderAction ? 'outline' : 'primary'}
              size="sm"
              title={listing}
              onClick={() => void openTarget('listing')}
            >
              <ExternalLink size={12} />
              View listing
            </Button>
          ) : null}
          <Button
            variant={!hasFolderAction && !hasMatch && !listing ? 'primary' : 'outline'}
            size="sm"
            onClick={onMatch}
          >
            <Wand2 size={12} />
            {hasMatch ? 'Change match' : 'Find match'}
          </Button>
        </div>
      </div>
    </section>
  );
}
