import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Aborting a refresh-all sweep must stop the location being scanned right
 * now, not just the ones queued after it. The signal used to be read only
 * between locations, so a cancel during a long walk did nothing until that
 * walk finished on its own.
 */
const h = vi.hoisted(() => ({
  cancelled: [] as number[],
  release: new Map<number, () => void>(),
  started: [] as number[],
}));

vi.mock('../../db', () => ({
  openDatabase: () => ({
    prepare: () => ({
      all: () => [
        { id: 1, name: 'One', path: '/one' },
        { id: 2, name: 'Two', path: '/two' },
      ],
    }),
  }),
}));

vi.mock('../pipeline', () => ({
  isScanRunning: () => false,
  startScan: (id: number) => {
    h.started.push(id);
    return new Promise((resolve) => {
      h.release.set(id, () =>
        resolve({
          completed_successfully: false,
          error: 'Scan canceled',
          status: 'Error',
          processed_items: 0,
          total_items: 0,
        }),
      );
    });
  },
  cancelScan: (id: number) => {
    h.cancelled.push(id);
    h.release.get(id)?.();
    return true;
  },
}));

const { refreshAllScans } = await import('../refresh-all');

beforeEach(() => {
  h.cancelled.length = 0;
  h.started.length = 0;
  h.release.clear();
});

describe('refreshAllScans abort', () => {
  it('cancels the in-flight location and starts no more', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const run = refreshAllScans({ signal: controller.signal, onProgress: () => {} });

    await vi.waitFor(() => expect(h.started).toEqual([1]));
    controller.abort();
    const result = await run;

    expect(h.cancelled).toContain(1);
    expect(h.started).toEqual([1]);
    expect(result.failed).toBe(1);
    // The listener does not outlive the sweep.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
