import { describe, expect, it } from 'vitest';
import { createBackgroundJobs } from '../background-jobs';

/**
 * `startScan` backgrounds thumbnail extraction so the UI gets its result at
 * once. The headless `--refresh-scans` run must instead wait for that work
 * before it exits, or `app.exit` kills extraction mid-run.
 */

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createBackgroundJobs', () => {
  it('drain waits for a tracked job to finish', async () => {
    const jobs = createBackgroundJobs();
    const d = deferred();
    jobs.track(d.promise);
    expect(jobs.size).toBe(1);
    let drained = false;
    const draining = jobs.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    d.resolve();
    await draining;
    expect(drained).toBe(true);
    expect(jobs.size).toBe(0);
  });

  it('drain does not reject when a job fails', async () => {
    const jobs = createBackgroundJobs();
    const d = deferred();
    jobs.track(d.promise.catch(() => {}));
    jobs.track(Promise.reject(new Error('boom')));
    d.reject(new Error('x'));
    await expect(jobs.drain()).resolves.toBeUndefined();
    expect(jobs.size).toBe(0);
  });

  it('drain also waits for jobs tracked while it was waiting', async () => {
    const jobs = createBackgroundJobs();
    const first = deferred();
    const second = deferred();
    jobs.track(first.promise);
    let drained = false;
    const draining = jobs.drain().then(() => {
      drained = true;
    });
    jobs.track(second.promise);
    first.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(drained).toBe(false);
    second.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('drain resolves at once with nothing tracked', async () => {
    await expect(createBackgroundJobs().drain()).resolves.toBeUndefined();
  });
});
