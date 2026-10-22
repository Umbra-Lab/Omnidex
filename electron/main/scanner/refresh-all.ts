import { openDatabase } from '../db';
import { type ActionProgress, emitProgress } from '../progress/bus';
import { cancelScan, startScan } from './pipeline';

/**
 * Refresh-all-scans service.
 *
 * Relocated from `index.ts`'s `runRefreshAndQuit` body (minus `app.exit`) so
 * the sweep is callable from both the CLI and tRPC. Reuses `startScan` /
 * `cancelScan` from `pipeline.ts` — scanning is NOT reimplemented here, only
 * the per-location orchestration loop.
 *
 * BOTH entry points here (`refreshAllScans` and `refreshOneScan`) publish
 * `refresh-scans` `ActionProgress` events to the shared `progressBus`, which is
 * what the renderer's `ScanProgressPanel` (via `trpc.progress.onProgress`) and
 * the CLI logger consume. `startScan` ALSO emits the legacy
 * `webContents.send('scan-progress')` channel internally, but the renderer no
 * longer listens to it — it stays live only for the `omnidex:scanner:start`
 * Electron-IPC smoke path exercised by `tests/electron-real-scan.spec.ts`.
 */

export interface RefreshOptions {
  /** Direct progress sink (testable). Defaults to the shared `progressBus`. */
  onProgress?: (p: ActionProgress) => void;
  /** Cancel the whole sweep; also aborts the in-flight location's scan. */
  signal?: AbortSignal;
}

export interface RefreshPerLocation {
  id: number;
  name: string;
  status: string;
  processed: number;
  total: number;
  error?: string;
}

export interface RefreshResult {
  locations: number;
  succeeded: number;
  failed: number;
  perLocation: RefreshPerLocation[];
}

export async function refreshAllScans(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const emit = opts.onProgress ?? emitProgress;
  const db = openDatabase();
  const rows = db
    .prepare('SELECT id, name, path FROM scan_locations WHERE id > 0 AND is_active = 1 ORDER BY id')
    .all() as { id: number; name: string; path: string }[];

  const total = rows.length;
  const perLocation: RefreshPerLocation[] = [];
  let succeeded = 0;
  let failed = 0;

  emit({
    action: 'refresh-scans',
    phase: 'start',
    processed: 0,
    total,
    currentName: null,
    message: `${total} active filesystem location(s) queued`,
  });

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r) continue;
    if (opts.signal?.aborted) {
      // Abort the in-flight location too (idempotent if none running) and stop.
      cancelScan(r.id);
      break;
    }

    emit({
      action: 'refresh-scans',
      phase: 'progress',
      processed: i,
      total,
      currentName: r.name,
      locationId: r.id,
      message: `-> [${r.id}] ${r.name}: ${r.path}`,
    });

    try {
      const result = await startScan(r.id);
      succeeded += 1;
      perLocation.push({
        id: r.id,
        name: r.name,
        status: result.status,
        processed: result.processed_items,
        total: result.total_items,
      });
      emit({
        action: 'refresh-scans',
        phase: 'progress',
        processed: i + 1,
        total,
        currentName: r.name,
        locationId: r.id,
        newAssets: result.new_assets_count ?? undefined,
        existingAssets: result.existing_assets_count ?? undefined,
        message: `OK [${r.id}] ${r.name} — phase=${result.status} processed=${result.processed_items}/${result.total_items}`,
      });
    } catch (e) {
      failed += 1;
      const message = (e as Error).message;
      perLocation.push({
        id: r.id,
        name: r.name,
        status: 'Error',
        processed: 0,
        total: 0,
        error: message,
      });
      emit({
        action: 'refresh-scans',
        phase: 'error',
        processed: i + 1,
        total,
        currentName: r.name,
        locationId: r.id,
        failed,
        message: `FAIL [${r.id}] ${r.name}: ${message}`,
      });
    }
  }

  emit({
    action: 'refresh-scans',
    phase: 'done',
    processed: total,
    total,
    currentName: null,
    failed,
    message: 'complete',
  });

  return { locations: total, succeeded, failed, perLocation };
}

/**
 * Single-location refresh ("Scan now" / first-folder onboarding scan).
 *
 * Publishes the same `refresh-scans` `ActionProgress` lifecycle to the shared
 * `progressBus` that `refreshAllScans` emits per location, so the renderer's
 * `ScanProgressPanel` (via `useActionProgress` / `trpc.progress.onProgress`)
 * shows single-location progress through the SAME transport as a full sweep.
 * This is what lets the panel drop its legacy `webContents.send('scan-progress')`
 * `useIpcEvent` fallback. `startScan` still walks/upserts the location; this
 * wrapper only adds the bus events around it (total=1, the one location).
 */
export async function refreshOneScan(
  locationId: number,
  opts: RefreshOptions = {},
): Promise<ReturnType<typeof startScan>> {
  const emit = opts.onProgress ?? emitProgress;

  emit({
    action: 'refresh-scans',
    phase: 'start',
    processed: 0,
    total: 1,
    currentName: null,
    locationId,
    message: `1 filesystem location queued`,
  });

  try {
    const result = await startScan(locationId);
    emit({
      action: 'refresh-scans',
      phase: 'done',
      processed: 1,
      total: 1,
      currentName: result.location_name,
      locationId,
      newAssets: result.new_assets_count ?? undefined,
      existingAssets: result.existing_assets_count ?? undefined,
      message: `OK [${locationId}] ${result.location_name ?? locationId} — phase=${result.status} processed=${result.processed_items}/${result.total_items}`,
    });
    return result;
  } catch (e) {
    const message = (e as Error).message;
    emit({
      action: 'refresh-scans',
      phase: 'error',
      processed: 1,
      total: 1,
      currentName: null,
      locationId,
      failed: 1,
      message: `FAIL [${locationId}]: ${message}`,
    });
    throw e;
  }
}

export { cancelScan } from './pipeline';
