import { EventEmitter } from 'node:events';

/**
 * Shared progress emitter for every long-running action (refresh / enrich).
 *
 * Single source of truth: the CLI logger, the tRPC `progress.onProgress`
 * subscription, and (later) WS8's dedup all subscribe to this one instance,
 * while the service layer (`scanner/refresh-all`, `orbital/enrich`,
 * `fab/enrich`) publishes to it. Because CLI runs are separate process
 * invocations that `app.exit` when done, this process-global singleton is
 * safe — there is never a concurrent CLI sweep and renderer window sharing it.
 *
 * Keep `ActionProgress` plain JSON-safe data (numbers / strings / null). It
 * crosses the electron-trpc subscription boundary via superjson; avoiding
 * `Date`/`Map`/`Set` keeps the high-frequency stream cheap and dependency-free.
 */
export type ActionName = 'refresh-scans' | 'enrich-orbital' | 'enrich-fab';

export type ActionPhase = 'start' | 'progress' | 'done' | 'error';

/** Discriminated progress event for every long-running action. */
export interface ActionProgress {
  action: ActionName;
  phase: ActionPhase;
  processed: number;
  total: number;
  currentName: string | null;
  // Action-specific counters, all optional:
  matched?: number;
  unmatched?: number;
  failed?: number;
  updated?: number;
  newAssets?: number;
  existingAssets?: number;
  locationId?: number;
  /** Human-readable line / error text. */
  message?: string | null;
  etaSeconds?: number | null;
}

type Events = {
  progress: [ActionProgress];
};

class ProgressBus extends EventEmitter<Events> {}

export const progressBus = new ProgressBus();
// Generous cap: one renderer subscription + CLI listener + future panels.
progressBus.setMaxListeners(50);

/** Publish a progress event to every subscriber of the shared bus. */
export function emitProgress(p: ActionProgress): void {
  progressBus.emit('progress', p);
}
