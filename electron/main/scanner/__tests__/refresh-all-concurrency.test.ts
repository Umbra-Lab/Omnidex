import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionProgress } from '../../progress/bus';

/**
 * Two ways a sweep used to report folders as failed that had scanned fine:
 * a second sweep started while one was running, and a sweep reaching a folder
 * whose own "Scan now" was still going. Both came from `startScan` answering
 * "already running" at once, which the sweep counted as a failure.
 */
const h = vi.hoisted(() => ({
  started: [] as number[],
  release: new Map<number, () => void>(),
  running: new Map<number, Promise<unknown>>(),
}));

const ok = (id: number) => ({
  location_id: id,
  completed_successfully: true,
  error: null,
  status: 'Completed',
  processed_items: 3,
  total_items: 3,
});

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
  isScanRunning: (id: number) => h.running.has(id),
  joinScan: (id: number) => h.running.get(id) ?? null,
  startScan: (id: number) => {
    if (h.running.has(id)) {
      // The real early answer for a duplicate request.
      return Promise.resolve({ ...ok(id), error: 'already running' });
    }
    h.started.push(id);
    const run = new Promise((resolve) => {
      h.release.set(id, () => {
        h.running.delete(id);
        resolve(ok(id));
      });
    });
    h.running.set(id, run);
    return run;
  },
  cancelScan: () => false,
}));

const { refreshAllScans } = await import('../refresh-all');

beforeEach(() => {
  h.started.length = 0;
  h.release.clear();
  h.running.clear();
});

async function releaseInOrder() {
  for (const id of [1, 2]) {
    await vi.waitFor(() => expect(h.release.has(id)).toBe(true));
    h.release.get(id)?.();
  }
}

describe('refreshAllScans concurrency', () => {
  it('joins a sweep already running instead of starting a second', async () => {
    const events: ActionProgress[] = [];
    const first = refreshAllScans({ onProgress: (p) => events.push(p) });
    const second = refreshAllScans({ onProgress: (p) => events.push(p) });
    expect(second).toBe(first);

    await releaseInOrder();
    const result = await first;

    expect(h.started).toEqual([1, 2]);
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(2);
    expect(events.filter((e) => e.phase === 'start')).toHaveLength(1);
    expect(events.filter((e) => e.phase === 'done')).toHaveLength(1);
  });

  it('starts a fresh sweep once the previous one has finished', async () => {
    const first = refreshAllScans({ onProgress: () => {} });
    await releaseInOrder();
    await first;

    const next = refreshAllScans({ onProgress: () => {} });
    expect(next).not.toBe(first);
    await releaseInOrder();
    expect((await next).succeeded).toBe(2);
  });

  it("waits for a folder's own scan instead of counting it as failed", async () => {
    // "Scan now" on folder 1 is still running when the sweep reaches it.
    let finishOwnScan: () => void = () => {};
    h.running.set(
      1,
      new Promise((resolve) => {
        finishOwnScan = () => {
          h.running.delete(1);
          resolve(ok(1));
        };
      }),
    );

    const sweep = refreshAllScans({ onProgress: () => {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.started).toEqual([]); // waiting on folder 1, not racing it
    finishOwnScan();
    await vi.waitFor(() => expect(h.release.has(2)).toBe(true));
    h.release.get(2)?.();

    const result = await sweep;
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(2);
    expect(h.started).toEqual([2]);
  });
});
