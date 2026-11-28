/**
 * A set of in-flight background promises that can be waited on.
 *
 * `startScan` returns before thumbnail extraction finishes so the UI gets its
 * result at once. The headless `--refresh-scans` run calls `drain()` before it
 * exits, so `app.exit` does not cut extraction off mid-run.
 */
export interface BackgroundJobs {
  /** Track a job until it settles. Its rejection is the caller's to handle. */
  track(job: Promise<unknown>): void;
  /** Resolve once every tracked job, including ones added meanwhile, settles. */
  drain(): Promise<void>;
  readonly size: number;
}

export function createBackgroundJobs(): BackgroundJobs {
  const pending = new Set<Promise<unknown>>();
  return {
    track(job) {
      const settled = job.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
    },
    async drain() {
      while (pending.size > 0) {
        await Promise.all(pending);
      }
    },
    get size() {
      return pending.size;
    },
  };
}
