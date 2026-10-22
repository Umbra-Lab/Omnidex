import { observable } from '@trpc/server/observable';
import { type ActionProgress, progressBus } from '../../progress/bus';
import { publicProcedure, router } from '../init';

/**
 * Live progress for every long-running action (refresh / enrich).
 *
 * A single subscription `progress.onProgress` streams every `ActionProgress`
 * event published to the shared `progressBus`; WS5 filters on the `action`
 * discriminant. The services (`scanner/refresh-all`, `orbital/enrich`,
 * `fab/enrich`) publish to the same bus, so the CLI logger and this
 * subscription observe identical events.
 *
 * electron-trpc keeps the observer open for `subscription` operations and runs
 * the returned teardown when the renderer unsubscribes (`subscription.stop`) or
 * the document is replaced (`did-start-navigation` cleanup, e.g. a reload), so
 * the `progressBus.off` below prevents listener leaks. The cleanup skips
 * same-document navigations
 * (`patches/electron-trpc@1.0.0-alpha.0.same-document-navigation.patch`), which
 * is what lets `AppShell`'s once-at-mount subscription outlive route changes
 * under hash routing. The `ActionProgress`
 * payload is plain JSON-safe data, so it crosses the boundary cleanly via the
 * configured superjson transformer.
 *
 * This is now the renderer's SOLE scan-progress transport: both
 * `scanner.refreshOne` and `scanner.refreshAll` publish `refresh-scans` events
 * to the bus, and `ScanProgressPanel` consumes only this subscription. The
 * pipeline's legacy `webContents.send('scan-progress')` channel still fires but
 * has no renderer consumer (it remains only for the `omnidex:scanner:start`
 * Electron-IPC smoke test). `fab-asset-discovered` in `fab/watcher.ts` is an
 * unrelated channel and stays live.
 */
export const progressRouter = router({
  /** Streams every `ActionProgress` event from the refresh/enrich services. */
  onProgress: publicProcedure.subscription(() =>
    observable<ActionProgress>((emit) => {
      const handler = (p: ActionProgress) => emit.next(p);
      progressBus.on('progress', handler);
      return () => {
        progressBus.off('progress', handler);
      };
    }),
  ),
});
