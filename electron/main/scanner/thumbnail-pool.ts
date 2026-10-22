import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

/**
 * Runs `.uasset` thumbnail extraction in disposable child processes.
 *
 * The `uasset` 0.6 crate sizes its allocations from counts it reads out of the
 * package header, and a malformed header makes it ask for absurd amounts — one
 * file in the live library asks for 5.86 GB. A failed allocation in Rust calls
 * `abort()`, which no JS `try`/`catch` and no `Promise.race` timeout can
 * intercept: the whole process dies. That is not hypothetical. It killed a
 * 20-location refresh at location 4, taking the run down from inside a
 * *background, best-effort* job that the index does not even need.
 *
 * So the extractor runs somewhere expendable. A worker owns one child and feeds
 * it one path at a time; if the child dies, the path in flight is by definition
 * the one that killed it, and gets recorded as a failure while a fresh child
 * picks up the next. Restart costs one addon load, and the library has roughly
 * one such file per two thousand.
 */

const CHILD_SOURCE = `
const { extractThumbnail } = require(process.env.OMNIDEX_UASSET_PATH);
const outDir = process.env.OMNIDEX_THUMB_DIR;
const size = Number(process.env.OMNIDEX_THUMB_SIZE);
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let png = null;
  try {
    png = await extractThumbnail(line, outDir, size);
  } catch {
    // A clean Err is the good outcome: report it as "no thumbnail" and live on.
  }
  process.stdout.write(JSON.stringify(png ?? null) + '\\n');
});
`;

export interface ThumbnailPoolOptions {
  readonly targets: readonly string[];
  readonly outDir: string;
  readonly size: number;
  readonly concurrency?: number;
  /** Kill the child if one file takes longer than this. Default 10s. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called per file. `png` is null when no thumbnail could be produced. */
  readonly onResult: (uassetPath: string, png: string | null) => void;
  /** Called when a file took the extractor process down with it. */
  readonly onCrash?: (uassetPath: string) => void;
  /** Test seam: JS source for the child. Defaults to the real extractor. */
  readonly childSource?: string;
}

interface Worker {
  child: ChildProcess;
  /** Resolves with the reply line, or null if the child died first. */
  pending: ((line: string | null) => void) | null;
}

export async function extractThumbnailsIsolated(opts: ThumbnailPoolOptions): Promise<void> {
  const { targets, outDir, size, onResult, onCrash, signal } = opts;
  if (targets.length === 0) return;

  const source = opts.childSource ?? CHILD_SOURCE;
  // Resolved here, in the parent, because the child is a `-e` string with no
  // module path of its own to resolve `@omnidex/uasset` against.
  const addonPath = opts.childSource
    ? ''
    : createRequire(import.meta.url).resolve('@omnidex/uasset');

  const spawnChild = (): Worker => {
    const child = spawn(process.execPath, ['-e', source], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        // process.execPath is electron.exe here; this makes it behave as node.
        ELECTRON_RUN_AS_NODE: '1',
        OMNIDEX_UASSET_PATH: addonPath,
        OMNIDEX_THUMB_DIR: outDir,
        OMNIDEX_THUMB_SIZE: String(size),
      },
    });
    const worker: Worker = { child, pending: null };
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        const resolve = worker.pending;
        worker.pending = null;
        resolve?.(line);
      });
    }
    // Covers abort, OOM kill, and any other death: the in-flight job is told
    // the child is gone rather than hanging forever on a reply that is not
    // coming. `exit` fires for every termination path, signal included.
    child.on('exit', () => {
      const resolve = worker.pending;
      worker.pending = null;
      resolve?.(null);
    });
    child.on('error', () => {
      const resolve = worker.pending;
      worker.pending = null;
      resolve?.(null);
    });
    return worker;
  };

  const timeoutMs = opts.timeoutMs ?? 10_000;

  const ask = (worker: Worker, path: string): Promise<string | null> =>
    new Promise((resolve) => {
      // A pathological file can hang the extractor instead of killing it.
      // Killing the child on timeout collapses that into the crash case, which
      // is already handled — the caller sees one dead worker either way.
      const timer = setTimeout(() => worker.child.kill(), timeoutMs);
      const settle = (line: string | null) => {
        clearTimeout(timer);
        resolve(line);
      };
      worker.pending = settle;
      if (!worker.child.stdin?.writable) {
        worker.pending = null;
        settle(null);
        return;
      }
      worker.child.stdin.write(`${path}\n`, (err) => {
        if (!err) return;
        // The child died between the writable check and the write.
        const pending = worker.pending;
        worker.pending = null;
        pending?.(null);
      });
    });

  /** One pass over `queue` with `lanes` children. Returns what died vs decoded. */
  const sweep = async (
    queue: readonly string[],
    lanes: number,
  ): Promise<{ decoded: Map<string, string | null>; crashed: string[] }> => {
    const decoded = new Map<string, string | null>();
    const crashed: string[] = [];
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      let worker = spawnChild();
      try {
        while (cursor < queue.length) {
          if (signal?.aborted) break;
          const path = queue[cursor++];
          const reply = await ask(worker, path);
          if (reply === null) {
            // The child is gone and `path` is what it was holding.
            crashed.push(path);
            worker = spawnChild();
            continue;
          }
          try {
            decoded.set(path, JSON.parse(reply) as string | null);
          } catch {
            decoded.set(path, null);
          }
        }
      } finally {
        worker.child.kill();
      }
    };

    const width = Math.max(1, Math.min(lanes, queue.length));
    await Promise.all(Array.from({ length: width }, runWorker));
    return { decoded, crashed };
  };

  const lanes = Math.max(1, opts.concurrency ?? 4);
  const first = await sweep(targets, lanes);

  // The parse allocates over a gigabyte on some files, so concurrent children
  // compete for headroom and the one that loses is not necessarily the one at
  // fault — a sequential sweep of the whole library crashes zero times, the
  // same files at four-wide do not. Retrying the casualties alone separates
  // "genuinely malformed" from "unlucky", recovers the innocent ones, and keeps
  // the crash report honest about which file is actually bad.
  const retry =
    first.crashed.length > 0 && lanes > 1 && !signal?.aborted
      ? await sweep(first.crashed, 1)
      : { decoded: new Map<string, string | null>(), crashed: first.crashed };

  for (const path of targets) {
    if (retry.decoded.has(path)) {
      onResult(path, retry.decoded.get(path) ?? null);
    } else if (first.decoded.has(path)) {
      onResult(path, first.decoded.get(path) ?? null);
    } else if (retry.crashed.includes(path)) {
      onCrash?.(path);
      onResult(path, null);
    }
    // Anything left was never reached — the run was aborted.
  }
}
