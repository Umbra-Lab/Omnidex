import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetClientStateForTests,
  get,
  OrbitalNotFoundError,
  RateLimitError,
} from '../client';

/**
 * Polite-client coverage: throttle slot-reservation race, Retry-After honor,
 * exponential backoff on 5xx, and the circuit breaker that stops hammering
 * orbital-market after repeated failures.
 *
 * `fetch` is mocked and fake timers drive both the inter-request spacing and
 * pRetry's backoff so the suite runs instantly without real network or waits.
 */

const parseJson = (raw: string): unknown => JSON.parse(raw);

/** A minimal `Response`-like stub good enough for `runRequest`. */
function fakeResponse(
  status: number,
  body = '"ok"',
  headers: Record<string, string> = {},
): Response {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetClientStateForTests();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('throttle slot reservation', () => {
  it('spaces two concurrent requests at least 300ms apart', async () => {
    const callTimes: number[] = [];
    fetchMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      return fakeResponse(200);
    });

    // Fire two requests concurrently — pLimit(2) lets both into runRequest,
    // so without a synchronous slot reservation they'd race and fire together.
    const p1 = get('/api/a', parseJson);
    const p2 = get('/api/b', parseJson);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([p1, p2]);

    expect(callTimes).toHaveLength(2);
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(300);
  });
});

describe('Retry-After + backoff', () => {
  it('retries a 429 and succeeds on the next attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, 'rate limited', { 'retry-after': '1' }))
      .mockResolvedValueOnce(fakeResponse(200, '"recovered"'));

    const promise = get('/api/x', parseJson);
    // Drive past the 300ms spacing + the Retry-After (1s) floor + backoff.
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits at least the Retry-After interval before retrying', async () => {
    const callTimes: number[] = [];
    fetchMock.mockImplementation(async () => {
      callTimes.push(Date.now());
      if (callTimes.length === 1) {
        return fakeResponse(429, 'slow down', { 'retry-after': '3' });
      }
      return fakeResponse(200, '"ok"');
    });

    const promise = get('/api/y', parseJson);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe('ok');

    expect(callTimes).toHaveLength(2);
    // The 3s Retry-After must be honored as a floor (minTimeout backoff is 500ms).
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(3000);
  });

  it('retries 5xx errors (exponential backoff) then gives up after the retry budget', async () => {
    fetchMock.mockResolvedValue(fakeResponse(503, 'unavailable'));

    const promise = get('/api/z', parseJson);
    const assertion = expect(promise).rejects.toBeInstanceOf(RateLimitError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // retries: 2 => 3 total attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('404 handling', () => {
  it('does not retry a 404 and throws OrbitalNotFoundError', async () => {
    fetchMock.mockResolvedValue(fakeResponse(404, 'nope'));

    const promise = get('/api/missing', parseJson);
    const assertion = expect(promise).rejects.toBeInstanceOf(OrbitalNotFoundError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated failures and then short-circuits without hitting the network', async () => {
    fetchMock.mockResolvedValue(fakeResponse(503, 'down'));

    // Each get() makes 3 attempts (1 + 2 retries). The breaker threshold is 5
    // consecutive failures, so the breaker trips during the second call. We
    // advance time in modest slices (well under the 60s cooldown) so the
    // breaker stays open for the third call.
    const r1 = get('/api/1', parseJson).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    await r1;

    const r2 = get('/api/2', parseJson).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err2 = await r2;
    expect(err2).toBeInstanceOf(RateLimitError);

    const callsBefore = fetchMock.mock.calls.length;
    expect(callsBefore).toBeGreaterThanOrEqual(5);

    // With the breaker open, a third request must NOT touch the network at all.
    const r3 = get('/api/3', parseJson).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err3 = await r3;

    expect(err3).toBeInstanceOf(RateLimitError);
    expect((err3 as RateLimitError).retryAfterMs).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('resets the failure counter on a successful response', async () => {
    // Four failures (below the threshold of 5), then a success, then more
    // failures — the breaker must NOT be open because the success reset things.
    fetchMock
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(200, '"ok"'));

    const promise = get('/api/recover', parseJson);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toBe('ok');

    // A subsequent request should reach the network (breaker still closed).
    fetchMock.mockResolvedValueOnce(fakeResponse(200, '"again"'));
    const callsBefore = fetchMock.mock.calls.length;
    const p2 = get('/api/again', parseJson);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p2).resolves.toBe('again');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
