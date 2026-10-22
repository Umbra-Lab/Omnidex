import { activeScanCount } from '../../scanner/pipeline';
import { cancelScan, refreshAllScans, refreshOneScan } from '../../scanner/refresh-all';
import { publicProcedure, router } from '../init';
import { idSchema } from '../schemas';

/**
 * Scanner action router. Every procedure delegates to the Step A service layer
 * in `scanner/refresh-all.ts` (which reuses `pipeline.ts`) — no scanning logic
 * is reimplemented here. Live progress flows through the `progress.onProgress`
 * subscription (Step C), not these mutation returns; the mutations return only
 * their final result objects.
 */
export const scannerRouter = router({
  /** Sweep every active filesystem location. Returns the per-location summary. */
  refreshAll: publicProcedure.mutation(() => refreshAllScans()),

  /** Re-scan a single location (thin pass-through to `startScan`). */
  refreshOne: publicProcedure.input(idSchema).mutation(({ input }) => refreshOneScan(input)),

  /** Cancel an in-flight scan for a location. */
  cancel: publicProcedure.input(idSchema).mutation(({ input }) => cancelScan(input)),

  /** Number of scans currently running (for UI disabled-state / polling). */
  activeCount: publicProcedure.query(() => activeScanCount()),
});
