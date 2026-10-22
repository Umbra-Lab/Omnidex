import { RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toaster';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useActionProgress } from '@/hooks/useActionProgress';
import { trpc } from '@/ipc/trpc';

export function MarketplaceTab() {
  const utils = trpc.useUtils();
  const { enrich, enrichActive } = useActionProgress();

  const enrichAll = trpc.orbital.enrichAll.useMutation({
    onSuccess: (summary) => {
      void utils.assets.invalidate();
      toast.success(
        `Enrichment complete · ${summary.matched} matched, ${summary.unmatched} unmatched` +
          (summary.failed > 0 ? `, ${summary.failed} failed` : ''),
      );
    },
  });

  // FAB library enrichment — pulls the user's FAB library (Epic) and enriches
  // matching assets. Mirrors the Orbital "Enrich now" trigger; progress flows
  // through the same `enrich` slot of `useActionProgress`. Stale Epic creds
  // can't be re-authed from the renderer (no interactive auth-code flow), so the
  // router returns `{ reauthRequired, redirectUrl }` instead of throwing — we
  // surface that as an "open Epic login" toast action.
  const enrichFab = trpc.fab.enrich.useMutation({
    onSuccess: (r) => {
      if (r.reauthRequired) {
        const url = r.redirectUrl;
        toast.error('Epic re-authorization required', {
          description: 'Your saved Epic credentials are stale. Re-authorize, then sync again.',
          action: url
            ? {
                label: 'Open Epic login',
                onClick: () => void window.omnidex?.shell?.openExternal(url),
              }
            : undefined,
        });
        return;
      }
      void utils.assets.invalidate();
      toast.success(`FAB sync complete · ${r.updated} enriched, ${r.unmatched} unmatched`);
    },
    onError: (err) => toast.error(err.message),
  });

  // FAB live watcher — real state read from the watcher service, toggled via
  // start/stop. Not a private-API call: it just watches the local vault folder.
  const watching = trpc.fab.isWatching.useQuery();
  const isWatching = watching.data?.watching ?? false;

  const startWatch = trpc.fab.startWatch.useMutation({
    onSuccess: () => {
      void utils.fab.isWatching.invalidate();
      toast.success('Watching the FAB vault for new downloads');
    },
  });
  const stopWatch = trpc.fab.stopWatch.useMutation({
    onSuccess: () => {
      void utils.fab.isWatching.invalidate();
      toast.info('Stopped watching the FAB vault');
    },
  });
  const watchPending = startWatch.isPending || stopWatch.isPending || watching.isPending;

  const onToggleWatch = (next: boolean) => {
    if (next) startWatch.mutate(undefined);
    else stopWatch.mutate();
  };

  // Orbital and FAB enrichment share the single `enrich` progress slot (only one
  // runs at a time — both buttons disable on `enrichActive`). Scope each card's
  // progress bar by `action` so a FAB sync renders under the FAB card, not the
  // Orbital one. The buttons are manual triggers only — enrichment never
  // auto-fires on scan (deferred to a later pass).
  const orbitalProgress = enrich?.action === 'enrich-orbital' ? enrich : null;
  const fabProgress = enrich?.action === 'enrich-fab' ? enrich : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Orbital Market</CardTitle>
          <CardDescription>
            Enrich local assets with marketplace metadata, descriptions, and galleries.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3 px-4 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label>Enrich library</Label>
              <span className="cap-11 text-surface-400">
                Match un-enriched assets against Orbital now.
              </span>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => enrichAll.mutate()}
              disabled={enrichActive || enrichAll.isPending}
            >
              <Sparkles size={12} />
              {orbitalProgress?.active || enrichAll.isPending
                ? 'Enriching…'
                : enrichActive
                  ? 'Busy…'
                  : 'Enrich now'}
            </Button>
          </div>

          {orbitalProgress ? (
            <div className="flex flex-col gap-1.5">
              <Progress value={orbitalProgress.percent} />
              <div className="flex items-center justify-between font-mono cap-10 tabular-nums text-surface-400">
                <span className="truncate pr-2">
                  {orbitalProgress.phase === 'done'
                    ? 'Done'
                    : orbitalProgress.phase === 'error'
                      ? (orbitalProgress.message ?? 'Failed')
                      : (orbitalProgress.currentName ?? 'Working…')}
                </span>
                <span className="shrink-0">
                  {orbitalProgress.processed}/{orbitalProgress.total}
                </span>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t border-surface-800/60 pt-3">
            <div className="flex flex-col">
              <Label className="text-surface-400">Auto-match on scan</Label>
              <span className="cap-11 text-surface-500">Coming in a later pass.</span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Wrapper span — a disabled Switch swallows pointer events, so
                    the trigger has to sit on an enabled element to show the tip
                    on hover. */}
                <span>
                  <Switch disabled aria-label="Auto-match on scan (coming soon)" />
                </span>
              </TooltipTrigger>
              <TooltipContent>Automatic enrichment arrives in a later workstream</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>FAB Marketplace</CardTitle>
          <CardDescription>
            Sync your FAB library to enrich matching assets, and watch the vault for new downloads.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3 px-4 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <Label>Sync FAB library</Label>
              <span className="cap-11 text-surface-400">
                Pull your FAB library and enrich matching assets.
              </span>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => enrichFab.mutate(undefined)}
              disabled={enrichActive || enrichFab.isPending}
            >
              <RefreshCw size={12} />
              {fabProgress?.active || enrichFab.isPending
                ? 'Syncing…'
                : enrichActive
                  ? 'Busy…'
                  : 'Sync now'}
            </Button>
          </div>

          {fabProgress ? (
            <div className="flex flex-col gap-1.5">
              <Progress value={fabProgress.percent} />
              <div className="flex items-center justify-between font-mono cap-10 tabular-nums text-surface-400">
                <span className="truncate pr-2">
                  {fabProgress.phase === 'done'
                    ? 'Done'
                    : fabProgress.phase === 'error'
                      ? (fabProgress.message ?? 'Failed')
                      : (fabProgress.currentName ?? fabProgress.message ?? 'Working…')}
                </span>
                <span className="shrink-0">
                  {fabProgress.processed}
                  {fabProgress.total > 0 ? `/${fabProgress.total}` : ''}
                </span>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t border-surface-800/60 pt-3">
            <div className="flex flex-col">
              <Label>Live watcher</Label>
              <span className="cap-11 text-surface-400">
                {isWatching ? 'Watching the FAB vault.' : 'Not watching.'}
              </span>
            </div>
            <Switch
              checked={isWatching}
              disabled={watchPending}
              onCheckedChange={onToggleWatch}
              aria-label="Toggle FAB live watcher"
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
