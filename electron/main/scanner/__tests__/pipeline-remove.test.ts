import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../db/repos/__tests__/fixtures/test-db';

/**
 * Removing a location while it scans. The walk is the scan's first await, so
 * that is where a removal lands: the location row (and, by cascade, its
 * assets) goes while the walk runs. `stopLocation` must make the scan end as
 * "removed": not a failure, and with nothing written for the missing location.
 */
const h = vi.hoisted(() => ({
  db: null as unknown,
  exists: true,
  releaseWalk: null as null | (() => void),
}));

vi.mock('../../db', () => ({ openDatabase: () => h.db }));
vi.mock('../../db/paths', () => ({ thumbnailsDir: () => '/tmp/omnidex-test-thumbs' }));
vi.mock('../../db/repos', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/repos')>();
  return {
    ...real,
    scanLocationsRepo: {
      ...real.scanLocationsRepo,
      getScanLocation: (_db: unknown, id: number) =>
        h.exists
          ? { id, name: 'Vault', path: '/lib', scan_mode: null, content_format: null }
          : undefined,
    },
  };
});
vi.mock('../walker', () => ({
  WALK_DIAGNOSTIC_KINDS: ['unreadable-folder'],
  walkRootWithDiagnostics: () =>
    new Promise((resolve) => {
      h.releaseWalk = () =>
        resolve({
          folders: [
            {
              name: 'Pack',
              absolutePath: '/lib/Pack',
              ecosystem: 'unreal_engine',
              sizeBytes: 1,
            },
          ],
          diagnostics: [],
        });
    }),
}));
vi.mock('../thumbnail-pool', () => ({ extractThumbnailsIsolated: vi.fn() }));
vi.mock('../unity', () => ({ scanUnityLocation: vi.fn() }));
vi.mock('../dcc-index', () => ({ scanDccLocation: vi.fn() }));

const { startScan, stopLocation, isScanRunning } = await import('../pipeline');

const assetCount = () =>
  ((h.db as Database).prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n;

beforeEach(() => {
  h.db = createTestDb();
  (h.db as Database).exec('ALTER TABLE assets ADD COLUMN has_local_thumbnail INTEGER DEFAULT 0');
  h.exists = true;
  h.releaseWalk = null;
});

describe('removing a location mid-scan', () => {
  it('ends the scan as removed, not failed, and writes nothing for it', async () => {
    const run = startScan(1);
    await vi.waitFor(() => expect(h.releaseWalk).not.toBeNull());

    // The person removes the folder while the walk is still going.
    h.exists = false;
    stopLocation(1);
    h.releaseWalk?.();

    const result = await run;
    expect(result).toMatchObject({
      status: 'Removed',
      completed_successfully: true,
      error: null,
    });
    expect(assetCount()).toBe(0);
    expect(isScanRunning(1)).toBe(false);
  });

  it('still reports a plain cancel as cancelled', async () => {
    const run = startScan(1);
    await vi.waitFor(() => expect(h.releaseWalk).not.toBeNull());
    stopLocation(1);
    h.releaseWalk?.();
    expect(await run).toMatchObject({ completed_successfully: false, error: 'Scan canceled' });
  });

  it('is a no-op for a location with nothing running', () => {
    expect(() => stopLocation(42)).not.toThrow();
  });
});
