import type { Database } from 'better-sqlite3';
import { aiTagsRepo } from '../db/repos';
import { type RunClaude, runClaudeCli } from './claude-cli';
import { buildTagPrompt, parseTagReply } from './prompt';

/**
 * Write search keywords for untagged packs, a batch of packs per `claude -p` call.
 *
 * Free by construction: it runs the user's Claude Code CLI on their subscription, with
 * API keys stripped from the child's environment. One call at a time, most-rated packs
 * first, so a run stopped partway has tagged the packs that matter most. A pack the
 * model leaves out stays untagged and is tried on the next run; a run stops after two
 * failed calls in a row (not logged in, out of quota, CLI missing) rather than failing
 * every remaining batch the same way.
 */

export interface EnrichTagsOptions {
  /** Most packs to tag this run. Default: all untagged packs. */
  limit?: number;
  /** Packs per call. Default 40: one reply stays short enough to come back whole. */
  batchSize?: number;
  /** Claude Code `--model`. Default `opus`. */
  model?: string;
  /** The call itself; tests pass a fake. */
  run?: RunClaude;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface EnrichTagsResult {
  /** Packs this run set out to tag. */
  total: number;
  /** Packs that got at least one tag. */
  tagged: number;
  /** Packs the model answered for with nothing to add (stored as '', not retried). */
  empty: number;
  /** Packs left untagged: in a failed call, or missing from the reply. */
  skipped: number;
  failedCalls: number;
  /** Why the run stopped before the end, or null. */
  stoppedEarly: string | null;
}

const DEFAULT_BATCH = 40;
const MAX_FAILURES_IN_A_ROW = 2;

export async function enrichTags(
  db: Database,
  options: EnrichTagsOptions = {},
): Promise<EnrichTagsResult> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH, 100));
  const model = options.model ?? 'opus';
  const run = options.run ?? runClaudeCli;
  const log = options.log ?? (() => {});
  const limit = options.limit && options.limit > 0 ? options.limit : Number.MAX_SAFE_INTEGER;

  // Read once: a pack the model skips stays NULL, and re-querying would hand it back
  // forever.
  const packs = aiTagsRepo.untaggedPacks(db, limit);
  const result: EnrichTagsResult = {
    total: packs.length,
    tagged: 0,
    empty: 0,
    skipped: 0,
    failedCalls: 0,
    stoppedEarly: null,
  };
  log(`${packs.length} pack(s) to tag with ${model}, ${batchSize} per call`);

  let failuresInARow = 0;
  for (let i = 0; i < packs.length; i += batchSize) {
    if (options.signal?.aborted) {
      result.stoppedEarly = 'Cancelled.';
      result.skipped += packs.length - i;
      break;
    }
    const batch = packs.slice(i, i + batchSize);
    let reply: string;
    try {
      reply = await run(buildTagPrompt(batch), { model, signal: options.signal });
      failuresInARow = 0;
    } catch (e) {
      result.failedCalls += 1;
      result.skipped += batch.length;
      failuresInARow += 1;
      const reason = (e as Error).message;
      log(`call failed (${i + 1}-${i + batch.length}): ${reason}`);
      if (failuresInARow >= MAX_FAILURES_IN_A_ROW || options.signal?.aborted) {
        result.stoppedEarly = reason;
        result.skipped += packs.length - (i + batch.length);
        break;
      }
      continue;
    }

    const tags = parseTagReply(reply, new Set(batch.map((p) => p.id)));
    db.exec('BEGIN');
    try {
      for (const pack of batch) {
        const t = tags.get(pack.id);
        if (!t) {
          result.skipped += 1;
          continue;
        }
        aiTagsRepo.setAiTags(db, pack.id, t);
        if (t.length > 0) result.tagged += 1;
        else result.empty += 1;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    log(
      `${Math.min(i + batch.length, packs.length)}/${packs.length} — ${result.tagged} tagged, ${result.skipped} skipped`,
    );
  }
  return result;
}

/** Exit code for the headless job: non-zero when any call failed or the run stopped. */
export function enrichTagsExitCode(r: EnrichTagsResult): number {
  return r.stoppedEarly || r.failedCalls > 0 ? 1 : 0;
}
