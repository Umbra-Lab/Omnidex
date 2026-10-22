import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/ipc/trpc';

/** Family of long-running action whose progress this hook tracks. */
type ActionName = 'refresh-scans' | 'enrich-orbital' | 'enrich-fab';
type ActionPhase = 'start' | 'progress' | 'done' | 'error';

/**
 * The latest progress event for one action family, normalized for the UI.
 *
 * Derived fields (`percent`, `active`) are computed once here so consumers
 * (`ScanProgressPanel`, `MarketplaceTab`) never recompute or touch the raw
 * tRPC subscription. `percent` is clamped to 0–100; `active` is true while the
 * action is `start`/`progress`.
 */
export interface ActionProgressState {
  action: ActionName;
  phase: ActionPhase;
  processed: number;
  total: number;
  /** Derived from processed/total, clamped 0–100. */
  percent: number;
  currentName: string | null;
  message: string | null;
  failed?: number;
  newAssets?: number;
  etaSeconds?: number | null;
  /** Originating scan location, when the event carries one (refresh only). */
  locationId?: number;
  /** True while `phase` is `start` or `progress`. */
  active: boolean;
}

/** How long a finished (`done`/`error`) slot lingers before auto-clearing. */
const AUTO_DISMISS_MS = 4_000;

function isEnrich(action: ActionName): boolean {
  return action === 'enrich-orbital' || action === 'enrich-fab';
}

/**
 * Subscribes to `trpc.progress.onProgress` and exposes the latest event per
 * action family (`scan` = `refresh-scans`, `enrich` = `enrich-orbital` |
 * `enrich-fab`). Centralizing the subscription here means the SCAN and
 * MARKETPLACE clusters consume normalized state and never touch the raw stream.
 *
 * On a `done` phase it invalidates the relevant queries so counts/grids
 * refresh — `assets` for both families, plus `scanLocations.list` on scan-done.
 * Finished slots auto-clear after `AUTO_DISMISS_MS` so the progress panel
 * dismisses itself.
 */
export function useActionProgress(): {
  scan: ActionProgressState | null;
  enrich: ActionProgressState | null;
  scanActive: boolean;
  enrichActive: boolean;
} {
  const utils = trpc.useUtils();
  const [scan, setScan] = useState<ActionProgressState | null>(null);
  const [enrich, setEnrich] = useState<ActionProgressState | null>(null);

  // Per-family auto-dismiss timers so a fresh event cancels a pending clear.
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enrichTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (scanTimer.current) clearTimeout(scanTimer.current);
      if (enrichTimer.current) clearTimeout(enrichTimer.current);
    };
  }, []);

  const onData = useCallback(
    (p: {
      action: ActionName;
      phase: ActionPhase;
      processed: number;
      total: number;
      currentName: string | null;
      failed?: number;
      newAssets?: number;
      locationId?: number;
      message?: string | null;
      etaSeconds?: number | null;
    }) => {
      const percent =
        p.total > 0 ? Math.max(0, Math.min(100, Math.round((p.processed / p.total) * 100))) : 0;
      const active = p.phase === 'start' || p.phase === 'progress';
      const state: ActionProgressState = {
        action: p.action,
        phase: p.phase,
        processed: p.processed,
        total: p.total,
        percent,
        currentName: p.currentName,
        message: p.message ?? null,
        failed: p.failed,
        newAssets: p.newAssets,
        etaSeconds: p.etaSeconds,
        locationId: p.locationId,
        active,
      };

      const family = isEnrich(p.action) ? 'enrich' : 'scan';
      const setSlot = family === 'enrich' ? setEnrich : setScan;
      const timer = family === 'enrich' ? enrichTimer : scanTimer;

      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }

      setSlot(state);

      if (p.phase === 'done') {
        void utils.assets.invalidate();
        if (family === 'scan') void utils.scanLocations.list.invalidate();
      }

      if (p.phase === 'done' || p.phase === 'error') {
        timer.current = setTimeout(() => {
          setSlot(null);
          timer.current = null;
        }, AUTO_DISMISS_MS);
      }
    },
    [utils],
  );

  trpc.progress.onProgress.useSubscription(undefined, { onData });

  return {
    scan,
    enrich,
    scanActive: scan?.active ?? false,
    enrichActive: enrich?.active ?? false,
  };
}
