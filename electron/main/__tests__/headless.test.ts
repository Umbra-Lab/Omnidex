import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  ALREADY_RUNNING_MESSAGE,
  createDialogThrottle,
  exitCodeForFailures,
  isHeadlessRun,
  readLineFrom,
  runHeadless,
} from '../headless';

/**
 * The testable half of the CLI job wiring in `index.ts`. A scheduled
 * `pnpm refresh-scans` is only trustworthy if it ends, and ends non-zero when
 * something went wrong; these pin both.
 */

function io() {
  return { exit: vi.fn<(code: number) => void>(), error: vi.fn() };
}

describe('isHeadlessRun', () => {
  it('recognises every job flag', () => {
    for (const flag of [
      '--refresh-scans',
      '--extract-missing-thumbs',
      '--enrich-orbital',
      '--enrich-fab',
      '--backfill-course-sources',
    ]) {
      expect(isHeadlessRun(['electron', '.', flag])).toBe(true);
    }
  });

  it('is false for a normal GUI launch and for value-only flags', () => {
    expect(isHeadlessRun(['electron', '.'])).toBe(false);
    expect(isHeadlessRun(['electron', '.', '--fab-token', 'x'])).toBe(false);
  });

  it('has a message that tells the user what to do', () => {
    expect(ALREADY_RUNNING_MESSAGE).toMatch(/already running/i);
    expect(ALREADY_RUNNING_MESSAGE).toMatch(/close it/i);
  });
});

describe('runHeadless', () => {
  it('exits 0 when the job succeeds', async () => {
    const o = io();
    await runHeadless('refresh', async () => 0, o);
    expect(o.exit).toHaveBeenCalledWith(0);
  });

  it('treats a job that returns nothing as success', async () => {
    const o = io();
    await runHeadless('refresh', async () => undefined, o);
    expect(o.exit).toHaveBeenCalledWith(0);
  });

  it('exits with the code the job returns', async () => {
    const o = io();
    await runHeadless('refresh', async () => 1, o);
    expect(o.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 and logs when the job throws, without rejecting', async () => {
    const o = io();
    await expect(
      runHeadless(
        'refresh',
        async () => {
          throw new Error('disk on fire');
        },
        o,
      ),
    ).resolves.toBeUndefined();
    expect(o.exit).toHaveBeenCalledTimes(1);
    expect(o.exit).toHaveBeenCalledWith(1);
    expect(String(o.error.mock.calls.flat().join(' '))).toContain('disk on fire');
  });
});

describe('exitCodeForFailures', () => {
  it('is 0 only when nothing failed', () => {
    expect(exitCodeForFailures(0)).toBe(0);
    expect(exitCodeForFailures(1)).toBe(1);
    expect(exitCodeForFailures(12)).toBe(1);
  });
});

describe('readLineFrom', () => {
  it('resolves with the first line', async () => {
    const s = new PassThrough();
    const p = readLineFrom(s);
    s.write('abc');
    s.write('123\nrest');
    await expect(p).resolves.toBe('abc123');
  });

  it('rejects when stdin closes with nothing on it (cron, </dev/null)', async () => {
    const s = new PassThrough();
    const p = readLineFrom(s);
    s.end();
    await expect(p).rejects.toThrow(/stdin/i);
  });

  it('accepts a final line with no newline before end of input', async () => {
    const s = new PassThrough();
    const p = readLineFrom(s);
    s.end('code-without-newline');
    await expect(p).resolves.toBe('code-without-newline');
  });

  it('rejects on a stream error', async () => {
    const s = new PassThrough();
    const p = readLineFrom(s);
    s.destroy(new Error('EBADF'));
    await expect(p).rejects.toThrow('EBADF');
  });
});

describe('createDialogThrottle', () => {
  it('allows the first dialog, then suppresses a burst until the window passes', () => {
    let t = 1_000;
    const allow = createDialogThrottle(10_000, () => t);
    expect(allow()).toBe(true);
    t += 50;
    expect(allow()).toBe(false);
    t += 5_000;
    expect(allow()).toBe(false);
    t += 5_000;
    expect(allow()).toBe(true);
  });
});
