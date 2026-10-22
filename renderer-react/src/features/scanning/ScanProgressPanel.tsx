import { Activity, Ban, CheckCircle2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/components/ui/toaster';
import { useActionProgress } from '@/hooks/useActionProgress';
import { trpc } from '@/ipc/trpc';
import { formatCount } from '@/lib/format';
import { panelSpring } from '@/motion/presets';

/**
 * Normalized view model the panel renders. Both single-location ("Scan now",
 * onboarding -> `scanner.refreshOne`) and full-sweep (`scanner.refreshAll`)
 * scans now feed it through one transport: the `progress.onProgress` tRPC
 * subscription, surfaced as `scan` by `useActionProgress`. (The pipeline's
 * legacy `webContents.send('scan-progress')` channel is no longer consumed by
 * the renderer — `refreshOneScan` publishes `refresh-scans` events to the same
 * progress bus that `refreshAllScans` does.)
 */
interface PanelState {
  readonly locationId: number | null;
  readonly title: string;
  readonly processed: number;
  readonly total: number;
  readonly percent: number;
  readonly newAssets: number | null;
  readonly done: boolean;
  readonly statusLabel: string;
}

export function ScanProgressPanel() {
  // Bus-sourced progress (refreshOne + refreshAll). `null` until the first event.
  const { scan } = useActionProgress();

  const [dismissed, setDismissed] = useState(false);

  // A fresh bus event means a new run started — undo any prior dismissal.
  useEffect(() => {
    if (scan?.active) setDismissed(false);
  }, [scan?.active]);

  const cancel = trpc.scanner.cancel.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const state: PanelState | null = scan
    ? {
        locationId: scan.locationId ?? null,
        title: scan.currentName ?? scan.message ?? 'Scanning',
        processed: scan.processed,
        total: scan.total,
        percent: scan.percent,
        newAssets: scan.newAssets ?? null,
        done: scan.phase === 'done' || scan.phase === 'error',
        statusLabel:
          scan.phase === 'error' ? 'Failed' : scan.phase === 'done' ? 'Completed' : 'Scanning',
      }
    : null;

  if (!state || dismissed) return null;

  const canCancel = !state.done && state.locationId != null;
  const failed = scan?.phase === 'error';

  return (
    <AnimatePresence>
      <motion.div
        // Failures announce assertively (`role="alert"`); in-progress and
        // completion updates announce politely so the scan's status reaches
        // screen-reader users without stealing focus.
        role={failed ? 'alert' : 'status'}
        aria-live={failed ? 'assertive' : 'polite'}
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={panelSpring}
        className="pointer-events-auto fixed bottom-4 right-4 z-40 w-[340px] overflow-hidden rounded-lg border border-surface-800/80 bg-surface-900/95 shadow-2xl backdrop-blur"
      >
        <div className="flex items-center justify-between gap-3 border-b border-surface-800/60 px-3 py-2">
          <div className="flex items-center gap-2">
            {state.done ? (
              <CheckCircle2 size={14} className="text-success-500" />
            ) : (
              <Activity size={14} className="text-accent-400 animate-pulse" />
            )}
            <span className="font-mono cap-10 uppercase tracking-[0.18em] text-surface-400">
              {state.statusLabel}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {canCancel ? (
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  if (state?.locationId != null) cancel.mutate(state.locationId);
                }}
                disabled={cancel.isPending}
                aria-label="Cancel scan"
                title="Cancel scan"
              >
                <Ban size={12} />
              </Button>
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss"
              title="Dismiss"
            >
              <X size={12} />
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 p-3">
          <div className="truncate cap-14 font-medium text-surface-100">{state.title}</div>
          <Progress value={state.percent} />
          <div className="flex justify-between font-mono cap-10 tabular-nums text-surface-400">
            <span>
              {formatCount(state.processed)} / {formatCount(state.total)}
            </span>
            <span>
              {state.newAssets != null
                ? `${formatCount(state.newAssets)} new`
                : `${state.percent}%`}
            </span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
