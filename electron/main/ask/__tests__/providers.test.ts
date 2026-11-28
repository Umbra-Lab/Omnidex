import { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock, default: { spawn: spawnMock } }));

import { streamLocal } from '../providers';

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}`;

describe('streamLocal', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a final event that has no trailing blank line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse([`${delta('Hel')}\n\n`, delta('lo')])),
    );
    const got: string[] = [];
    const res = await streamLocal(
      'http://x/v1',
      'm',
      [],
      (t) => got.push(t),
      new AbortController().signal,
    );
    expect(res.text).toBe('Hello');
    expect(got).toEqual(['Hel', 'lo']);
  });

  it('reports a cancel as Cancelled., not a connection failure', async () => {
    const ac = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        ac.abort();
        return Promise.reject(new DOMException('This operation was aborted', 'AbortError'));
      }),
    );
    await expect(streamLocal('http://x/v1', 'm', [], () => {}, ac.signal)).rejects.toThrow(
      /^Cancelled\.$/,
    );
  });

  it('reports a timeout as a timeout, not a connection failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')),
    );
    await expect(
      streamLocal('http://x/v1', 'm', [], () => {}, new AbortController().signal),
    ).rejects.toThrow(/took longer than 5 minutes/);
  });

  it('still reports a refused connection as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(
      streamLocal('http://x/v1', 'm', [], () => {}, new AbortController().signal),
    ).rejects.toThrow(/Could not reach the local model server/);
  });

  it('reports a cancel during streaming as Cancelled.', async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        ac.abort();
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(streamLocal('http://x/v1', 'm', [], () => {}, ac.signal)).rejects.toThrow(
      /^Cancelled\.$/,
    );
  });

  it('reports an AbortError that is not a cancel as a dropped connection', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(
      streamLocal('http://x/v1', 'm', [], () => {}, new AbortController().signal),
    ).rejects.toThrow(/connection to the local model server dropped/);
  });
});

describe('claudeCodeAvailable', () => {
  function fakeProbe() {
    const p = new EventEmitter() as EventEmitter & { kill: () => void; stdout: PassThrough };
    p.kill = vi.fn();
    return p;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    spawnMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('does not cache a timeout; a later probe retries', async () => {
    const first = fakeProbe();
    spawnMock.mockReturnValueOnce(first);
    const { claudeCodeAvailable: probe } = await import('../providers');
    const a = probe();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await a).toBe(false);

    // Past the retry throttle, the next probe spawns again.
    await vi.advanceTimersByTimeAsync(60_000);
    const second = fakeProbe();
    spawnMock.mockReturnValueOnce(second);
    const b = probe();
    second.emit('close', 0);
    expect(await b).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('caches a definitive negative (non-zero exit)', async () => {
    const first = fakeProbe();
    spawnMock.mockReturnValueOnce(first);
    const { claudeCodeAvailable: probe } = await import('../providers');
    const a = probe();
    first.emit('close', 127);
    expect(await a).toBe(false);
    expect(await probe()).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
