import { describe, expect, it, vi } from 'vitest';

/**
 * `joinScan` hands a sweep the run already in flight for a folder, so the
 * bookkeeping behind it must be set before the run can settle and cleared
 * however it ends. A stale entry would leave every later sweep waiting on a
 * finished promise instead of scanning.
 */
const h = vi.hoisted(() => ({ lookups: 0 }));

vi.mock('../../db', () => ({ openDatabase: () => ({}) }));
vi.mock('../../db/repos', () => ({
  assetsRepo: {},
  coursesRepo: {},
  scanDiagnosticsRepo: {},
  scanLocationsRepo: {
    // No such location: scanLocation throws before its first await, the
    // earliest a run can end.
    getScanLocation: () => {
      h.lookups += 1;
      return undefined;
    },
  },
}));

const { joinScan, startScan } = await import('../pipeline');

describe('joinScan', () => {
  it('returns the in-flight run, and nothing once it has ended', async () => {
    expect(joinScan(7)).toBeNull();

    const run = startScan(7);
    const joined = joinScan(7);
    expect(joined).not.toBeNull();
    await expect(joined).rejects.toThrow('Scan location 7 not found');
    await expect(run).rejects.toThrow('Scan location 7 not found');

    expect(joinScan(7)).toBeNull();
    // Nothing still claims the folder, so a new scan really starts.
    await expect(startScan(7)).rejects.toThrow('not found');
    expect(h.lookups).toBe(2);
  });
});
