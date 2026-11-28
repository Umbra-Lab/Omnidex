import type { Readable } from 'node:stream';

/**
 * Pure helpers behind the CLI job flags in `index.ts` (`--refresh-scans`,
 * `--enrich-fab`, ...). They live here so vitest can exercise them without
 * Electron; `index.ts` only wires them to `app.exit` and `process.stdin`.
 *
 * The contract a scheduled run relies on: every job ends, and ends non-zero
 * when something went wrong.
 */

/** Flags that run one job and exit instead of opening a window. */
export const HEADLESS_JOB_FLAGS = [
  '--refresh-scans',
  '--extract-missing-thumbs',
  '--enrich-orbital',
  '--enrich-fab',
  '--backfill-course-sources',
  '--enrich-tags',
  '--clear-ai-tags',
  '--inject-gallery-fixture',
  '--revert-gallery-fixture',
  '--check-fixture',
] as const;

export function isHeadlessRun(argv: readonly string[]): boolean {
  return HEADLESS_JOB_FLAGS.some((flag) => argv.includes(flag));
}

/** Printed when a job flag loses the single-instance lock to an open window. */
export const ALREADY_RUNNING_MESSAGE = 'Omnidex is already running; close it and run this again.';

export interface HeadlessIo {
  exit: (code: number) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Run one CLI job and exit with its code. A job returns its exit code (nothing
 * means 0); a throw is logged and exits 1. Never rejects, so `void
 * runHeadless(...)` cannot become an unhandled rejection that leaves the
 * process running with nothing to do.
 */
export async function runHeadless(
  tag: string,
  job: () => Promise<number | undefined>,
  io: HeadlessIo,
): Promise<void> {
  let code: number;
  try {
    code = (await job()) ?? 0;
  } catch (err) {
    io.error(`[${tag}] failed:`, err instanceof Error ? (err.stack ?? err.message) : err);
    code = 1;
  }
  io.exit(code);
}

/** A job that reports per-item failures exits 1 if any item failed. */
export function exitCodeForFailures(failed: number): number {
  return failed > 0 ? 1 : 0;
}

/**
 * Exit code for `--enrich-orbital` once the run finished (an interrupted run
 * exits 1 before this). A failed row stays unattempted and the next run
 * retries it, so a few transient failures don't fail a scheduled job. Only an
 * outage (rows to do, none answered) exits 1. Partial failures are printed.
 */
export function orbitalExitCode(r: {
  total: number;
  matched: number;
  unmatched: number;
  failed: number;
}): number {
  return r.total > 0 && r.matched + r.unmatched === 0 ? 1 : 0;
}

/** Printed when a GUI launch loses the single-instance lock. */
export const ANOTHER_PROCESS_MESSAGE =
  'Another Omnidex process is running (the window, or a CLI job such as refresh-scans); not starting a second one.';

/**
 * Read one line from a stream. Rejects if the stream ends or closes before
 * any input arrives (stdin from `/dev/null` or cron), so the caller can exit
 * instead of waiting forever. A last line without a trailing newline counts.
 */
export function readLineFrom(stream: Readable): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onEnd);
      stream.removeListener('error', onError);
      stream.pause();
      fn();
    };
    const onData = (chunk: string): void => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        finish(() => resolve(line));
      }
    };
    const onEnd = (): void => {
      const line = buf.trim();
      finish(() =>
        line
          ? resolve(line)
          : reject(new Error('stdin closed before any input was read (no terminal attached?)')),
      );
    };
    const onError = (err: Error): void => finish(() => reject(err));
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onError);
    stream.resume();
  });
}

/**
 * Gate for the non-fatal error dialog: the first error shows one, and every
 * error in the next `windowMs` is log-only. A burst of rejections would
 * otherwise stack one synchronous modal per error and stall the main loop.
 */
export function createDialogThrottle(
  windowMs = 10_000,
  now: () => number = Date.now,
): () => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t - last < windowMs) return false;
    last = t;
    return true;
  };
}
