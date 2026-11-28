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
  // forever. Copies of one pack (same title and size in several folders) are asked about
  // once, and the answer is stored on every copy.
  const all = aiTagsRepo.untaggedPacks(db, limit);
  const copiesOf = new Map<number, number[]>();
  const firstOf = new Map<string, number>();
  const packs = all.filter((p) => {
    const key = `${(p.orbital_title ?? p.name).trim().toLowerCase()}\u0000${p.file_size}`;
    const first = firstOf.get(key);
    if (first === undefined) {
      firstOf.set(key, p.id);
      copiesOf.set(p.id, [p.id]);
      return true;
    }
    copiesOf.get(first)?.push(p.id);
    return false;
  });
  const copies = (id: number) => copiesOf.get(id) ?? [id];
  const result: EnrichTagsResult = {
    total: all.length,
    tagged: 0,
    empty: 0,
    skipped: 0,
    failedCalls: 0,
    stoppedEarly: null,
  };
  log(
    `${all.length} pack(s) to tag (${packs.length} after folding copies) with ${model}, ${batchSize} per call`,
  );

  let failuresInARow = 0;
  for (let i = 0; i < packs.length; i += batchSize) {
    const countFrom = (from: number, to = packs.length) =>
      packs.slice(from, to).reduce((n, p) => n + copies(p.id).length, 0);
    if (options.signal?.aborted) {
      result.stoppedEarly = 'Cancelled.';
      result.skipped += countFrom(i);
      break;
    }
    const batch = packs.slice(i, i + batchSize);
    let reply: string;
    try {
      reply = await run(buildTagPrompt(batch), { model, signal: options.signal });
    } catch (e) {
      result.failedCalls += 1;
      result.skipped += countFrom(i, i + batch.length);
      failuresInARow += 1;
      const reason = (e as Error).message;
      log(`call failed (${i + 1}-${i + batch.length}): ${reason}`);
      if (failuresInARow >= MAX_FAILURES_IN_A_ROW || options.signal?.aborted) {
        result.stoppedEarly = reason;
        result.skipped += countFrom(i + batch.length);
        break;
      }
      continue;
    }

    const tags = parseTagReply(reply, new Set(batch.map((p) => p.id)));
    if (tags.size === 0) {
      // A reply with nothing usable is a failed call: counting it keeps the exit code
      // honest, and two in a row stop a run that would re-pick the same packs forever.
      result.failedCalls += 1;
      result.skipped += countFrom(i, i + batch.length);
      failuresInARow += 1;
      log(`reply had no usable tags (${i + 1}-${i + batch.length}): ${reply.slice(0, 120)}`);
      if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        result.stoppedEarly = 'The model replied twice in a row without usable tags.';
        result.skipped += countFrom(i + batch.length);
        break;
      }
      continue;
    }
    failuresInARow = 0;
    db.exec('BEGIN');
    try {
      for (const pack of batch) {
        const t = tags.get(pack.id);
        const ids = copies(pack.id);
        if (!t) {
          result.skipped += ids.length;
          continue;
        }
        for (const id of ids) aiTagsRepo.setAiTags(db, id, t);
        if (t.length > 0) result.tagged += ids.length;
        else result.empty += ids.length;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    log(
      `${countFrom(0, i + batch.length)}/${all.length} — ${result.tagged} tagged, ${result.skipped} skipped`,
    );
  }
  return result;
}

/** Exit code for the headless job: non-zero when any call failed or the run stopped. */
export function enrichTagsExitCode(r: EnrichTagsResult): number {
  return r.stoppedEarly || r.failedCalls > 0 ? 1 : 0;
}
