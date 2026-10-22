import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';

/**
 * Rate-limited HTTP client for Orbital Market (`https://orbital-market.com`).
 *
 * Port of the throttling + retry discipline from
 * `src-tauri/src/orbital/api.rs`, hardened to be a polite, minimal-footprint
 * client: it honors `Retry-After`, backs off exponentially on 429/5xx, and
 * trips a process-wide circuit breaker after repeated failures so we stop
 * hammering orbital-market the moment it signals distress. Concurrency stays
 * intentionally low (`pLimit(2)` + 300ms spacing) — fewer/smaller requests is
 * the goal, never faster.
 */

const ORBITAL_BASE_URL = 'https://orbital-market.com';
const MIN_REQUEST_INTERVAL_MS = 300;

// Per-attempt timeout: a single fetch may not exceed this. Kept well under the
// overall deadline so one stuck request can't pin a `pLimit(2)` slot.
const ATTEMPT_TIMEOUT_MS = 15_000;
// Overall deadline across all retries for one logical request. Bounds the
// worst-case head-of-line blocking on the shared queue.
const OVERALL_DEADLINE_MS = 45_000;

// Circuit breaker: after this many consecutive transport/429/5xx failures we
// stop issuing requests for COOLDOWN_MS so we don't keep poking a service that
// is already telling us to back off.
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

// p-limit caps in-flight requests; additional spacing happens via lastRequestAt.
const inflight = pLimit(2);
let lastRequestAt = 0;

// Circuit-breaker state (process-wide, intentionally module-level).
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/**
 * Reserve the next request slot and wait out the inter-request spacing.
 *
 * The reservation (`lastRequestAt = scheduled`) happens *synchronously* before
 * any `await`, so two concurrent callers under `pLimit(2)` can't both read the
 * same stale `lastRequestAt` and fire together — the second caller sees the
 * already-advanced timestamp and schedules a further `MIN_REQUEST_INTERVAL_MS`
 * out. This serializes spacing correctly even at concurrency 2.
 */
async function throttle(): Promise<void> {
  const now = Date.now();
  const scheduled = Math.max(now, lastRequestAt + MIN_REQUEST_INTERVAL_MS);
  lastRequestAt = scheduled;
  const wait = scheduled - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
}

function browserHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Origin: ORBITAL_BASE_URL,
    Referer: `${ORBITAL_BASE_URL}/`,
  };
}

/** 404 — the slug doesn't exist. Callers treat this as a definitive "no match". */
export class OrbitalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrbitalNotFoundError';
  }
}

/**
 * 429/5xx, an open circuit breaker, or a transport failure. Carries a hint for
 * *how long* to wait before the next attempt (`retryAfterMs`), sourced from a
 * `Retry-After` header when present or the breaker cooldown otherwise.
 */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  readonly status?: number;
  /** True when this was raised by the open circuit breaker (no network hit). */
  readonly breakerOpen: boolean;

  constructor(
    message: string,
    retryAfterMs: number,
    options: { status?: number; breakerOpen?: boolean } = {},
  ) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.status = options.status;
    this.breakerOpen = options.breakerOpen ?? false;
  }
}

/**
 * Parse a `Retry-After` header (delta-seconds or an HTTP-date) into milliseconds.
 * Returns `0` when absent/unparseable so callers fall back to normal backoff.
 */
function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return 0;
}

function noteFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    consecutiveFailures = 0;
  }
}

function noteSuccess(): void {
  consecutiveFailures = 0;
}

/**
 * One network attempt. `timeoutMs` bounds this single attempt; the caller is
 * responsible for the overall multi-retry deadline. Throws `RateLimitError`
 * on 429/5xx/transport failure (so backoff + the breaker engage) and
 * `OrbitalNotFoundError` on 404.
 */
async function runRequest<T>(
  path: string,
  init: RequestInit,
  parse: (body: string) => T,
  timeoutMs: number,
): Promise<T> {
  // Short-circuit while the breaker is open — don't even touch the network.
  const now = Date.now();
  if (now < breakerOpenUntil) {
    throw new RateLimitError(`Orbital circuit breaker open for ${path}`, breakerOpenUntil - now, {
      breakerOpen: true,
    });
  }

  const url = `${ORBITAL_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await throttle();
    const response = await fetch(url, {
      ...init,
      headers: { ...browserHeaders(), ...(init.headers as Record<string, string>) },
      signal: controller.signal,
    });
    if (response.status === 404) {
      // 404 is a definitive answer, not a sign of distress — don't trip the breaker.
      noteSuccess();
      throw new OrbitalNotFoundError(`${path} returned 404`);
    }
    if (response.status === 429 || response.status >= 500) {
      noteFailure();
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw new RateLimitError(`Orbital ${response.status}: ${path}`, retryAfterMs, {
        status: response.status,
      });
    }
    if (!response.ok) {
      // Other 4xx — a request-shape problem, not rate limiting. Don't retry,
      // don't trip the breaker.
      noteSuccess();
      throw new Error(`Orbital ${response.status}: ${path}`);
    }
    const body = await response.text();
    noteSuccess();
    return parse(body);
  } catch (err) {
    // Transport failures (DNS, connection reset, per-attempt timeout/abort)
    // count toward the breaker too. OrbitalNotFoundError and the generic 4xx
    // Error above already reset/preserved breaker state, so leave those alone.
    if (
      !(err instanceof OrbitalNotFoundError) &&
      !(err instanceof RateLimitError) &&
      !(err instanceof Error && /^Orbital \d/.test(err.message))
    ) {
      noteFailure();
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Run `runRequest` with pRetry, honoring `Retry-After` as a backoff *floor*
 * and an overall deadline as a ceiling. Per-attempt timeout is the smaller of
 * `ATTEMPT_TIMEOUT_MS` and the remaining time until the deadline.
 */
async function withRetry<T>(
  path: string,
  init: RequestInit,
  parse: (body: string) => T,
): Promise<T> {
  const deadline = Date.now() + OVERALL_DEADLINE_MS;

  return pRetry(
    () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Out of time — fail fast and free the queue slot.
        throw new AbortError(`Orbital request deadline exceeded: ${path}`);
      }
      return runRequest(path, init, parse, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
    },
    {
      retries: 2,
      minTimeout: 500,
      factor: 2,
      // Never retry definitive answers (404). Fail fast when the breaker is
      // already open — retrying would only spin until the cooldown, pinning the
      // queue slot. Stop once the overall deadline has passed.
      shouldRetry: ({ error }) =>
        !(error instanceof OrbitalNotFoundError) &&
        !(error instanceof RateLimitError && error.breakerOpen) &&
        Date.now() < deadline,
      // Honor Retry-After as a floor on the wait before the next attempt.
      // pRetry's own exponential delay still runs; we add the extra slack here
      // so we never retry *sooner* than the server asked. Skipped for
      // breaker-open errors (those aren't retried).
      onFailedAttempt: async ({ error, retryDelay }) => {
        if (
          error instanceof RateLimitError &&
          !error.breakerOpen &&
          error.retryAfterMs > retryDelay
        ) {
          const extra = Math.min(error.retryAfterMs - retryDelay, deadline - Date.now());
          if (extra > 0) {
            await new Promise((r) => setTimeout(r, extra));
          }
        }
      },
    },
  );
}

export async function get<T>(path: string, parse: (body: string) => T): Promise<T> {
  return inflight(() => withRetry(path, { method: 'GET' }, parse));
}

export async function post<T>(path: string, body: unknown, parse: (body: string) => T): Promise<T> {
  return inflight(() =>
    withRetry(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      parse,
    ),
  );
}

/**
 * Reset circuit-breaker + throttle state. Test-only hook so each case starts
 * from a clean slate; not part of the runtime surface.
 */
export function __resetClientStateForTests(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
  lastRequestAt = 0;
}
