import { describe, expect, it, vi } from 'vitest';
import {
  createErrorHandler,
  getErrorMessage,
  getRetryDelay,
  isOmnidexError,
  isRetryable,
  isUserError,
  type OmnidexError,
  type OmnidexErrorKind,
} from '../errors';

const ALL_KINDS: OmnidexErrorKind[] = [
  'database',
  'fileSystem',
  'network',
  'parse',
  'notFound',
  'config',
  'externalService',
  'initialization',
  'invalidInput',
  'cache',
  'auth',
  'internal',
  'rateLimited',
  'migration',
  'backup',
  'search',
];

const err = (kind: OmnidexErrorKind, message = 'boom'): OmnidexError => ({ kind, message });

describe('isOmnidexError', () => {
  it('accepts a well-formed error of every one of the 16 kinds', () => {
    for (const kind of ALL_KINDS) {
      expect(isOmnidexError(err(kind))).toBe(true);
    }
  });

  it('narrows the type so kind/message are accessible', () => {
    const e: unknown = err('notFound', 'no asset');
    if (isOmnidexError(e)) {
      // Compile-time proof the guard narrowed; runtime asserts the values.
      expect(e.kind).toBe('notFound');
      expect(e.message).toBe('no asset');
    } else {
      throw new Error('guard should have matched');
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'database'],
    ['a number', 42],
    ['an array', ['database', 'msg']],
  ])('rejects %s', (_label, value) => {
    expect(isOmnidexError(value)).toBe(false);
  });

  it('rejects an object missing message', () => {
    expect(isOmnidexError({ kind: 'database' })).toBe(false);
  });

  it('rejects an object missing kind', () => {
    expect(isOmnidexError({ message: 'boom' })).toBe(false);
  });

  it('rejects an unknown kind even with the right shape', () => {
    expect(isOmnidexError({ kind: 'kaboom', message: 'boom' })).toBe(false);
  });

  it('rejects when message is not a string', () => {
    expect(isOmnidexError({ kind: 'database', message: 500 })).toBe(false);
  });

  it('does not throw on a frozen / exotic object', () => {
    expect(isOmnidexError(Object.freeze({ kind: 'database', message: 'frozen' }))).toBe(true);
  });
});

describe('isRetryable', () => {
  it('is true for exactly network, externalService, rateLimited', () => {
    expect(isRetryable(err('network'))).toBe(true);
    expect(isRetryable(err('externalService'))).toBe(true);
    expect(isRetryable(err('rateLimited'))).toBe(true);
  });

  it('is false for every non-retryable kind', () => {
    const retryable = new Set<OmnidexErrorKind>(['network', 'externalService', 'rateLimited']);
    for (const kind of ALL_KINDS) {
      if (!retryable.has(kind)) expect(isRetryable(err(kind))).toBe(false);
    }
  });
});

describe('isUserError', () => {
  it('is true for exactly invalidInput, notFound, auth', () => {
    expect(isUserError(err('invalidInput'))).toBe(true);
    expect(isUserError(err('notFound'))).toBe(true);
    expect(isUserError(err('auth'))).toBe(true);
  });

  it('is false for every non-user kind', () => {
    const userKinds = new Set<OmnidexErrorKind>(['invalidInput', 'notFound', 'auth']);
    for (const kind of ALL_KINDS) {
      if (!userKinds.has(kind)) expect(isUserError(err(kind))).toBe(false);
    }
  });

  it('treats retryable and user error sets as disjoint', () => {
    for (const kind of ALL_KINDS) {
      expect(isRetryable(err(kind)) && isUserError(err(kind))).toBe(false);
    }
  });
});

describe('getRetryDelay', () => {
  it('parses an explicit "Retry after N seconds" out of a rateLimited message', () => {
    expect(getRetryDelay(err('rateLimited', 'Retry after 60 seconds'))).toBe(60_000);
    expect(getRetryDelay(err('rateLimited', 'slow down, 5 second cooldown'))).toBe(5_000);
  });

  it('is case-insensitive and tolerates "second" singular', () => {
    expect(getRetryDelay(err('rateLimited', 'wait 1 Second'))).toBe(1_000);
  });

  it('falls back to 60s for rateLimited with no parsable delay', () => {
    expect(getRetryDelay(err('rateLimited', 'too many requests'))).toBe(60_000);
  });

  it('uses the first number when several appear', () => {
    expect(getRetryDelay(err('rateLimited', 'retry in 30 seconds (was 90 seconds)'))).toBe(30_000);
  });

  it('returns sensible per-kind defaults for the other retryable kinds', () => {
    expect(getRetryDelay(err('network'))).toBe(5_000);
    expect(getRetryDelay(err('externalService'))).toBe(10_000);
  });

  it('returns the 5s default for non-retryable kinds', () => {
    expect(getRetryDelay(err('database'))).toBe(5_000);
    expect(getRetryDelay(err('internal'))).toBe(5_000);
  });
});

describe('getErrorMessage', () => {
  it('passes the raw message through for user errors', () => {
    expect(getErrorMessage(err('invalidInput', 'Name is required'))).toBe('Name is required');
    expect(getErrorMessage(err('notFound', 'Asset 7 not found'))).toBe('Asset 7 not found');
    expect(getErrorMessage(err('auth', 'Token expired'))).toBe('Token expired');
  });

  it('interpolates the original message for rateLimited', () => {
    expect(getErrorMessage(err('rateLimited', 'Retry after 30 seconds'))).toBe(
      'Too many requests. Retry after 30 seconds',
    );
  });

  it('hides internals behind a friendly message for each system kind', () => {
    const friendly: Record<string, string> = {
      database: 'A database error occurred. Please try again.',
      fileSystem: 'Unable to access the file system. Check permissions.',
      network: 'Network connection failed. Check your internet connection.',
      externalService: 'External service unavailable. Please try again later.',
      migration: 'Database upgrade failed. A backup has been created.',
      backup: 'Backup operation failed. Check disk space.',
      search: 'Search failed. Please try a different query.',
      initialization: 'Application failed to start properly.',
      config: 'Configuration error. Please check settings.',
      cache: 'Cache error. Clearing cache may help.',
      parse: 'Failed to process data. The format may be invalid.',
      internal: 'An unexpected error occurred.',
    };
    for (const [kind, text] of Object.entries(friendly)) {
      expect(getErrorMessage(err(kind as OmnidexErrorKind, 'leaky internal detail'))).toBe(text);
    }
  });

  it('never leaks the raw message for non-user system errors', () => {
    const secret = 'SELECT * FROM users WHERE password';
    for (const kind of ALL_KINDS) {
      if (isUserError(err(kind)) || kind === 'rateLimited') continue;
      expect(getErrorMessage(err(kind, secret))).not.toContain(secret);
    }
  });

  it('returns a message for every kind (no kind falls through to empty)', () => {
    for (const kind of ALL_KINDS) {
      expect(getErrorMessage(err(kind)).length).toBeGreaterThan(0);
    }
  });
});

describe('createErrorHandler', () => {
  it('routes retryable errors to onRetryableError with the computed delay', () => {
    const onRetryableError = vi.fn();
    const onUserError = vi.fn();
    const onSystemError = vi.fn();
    const onUnknownError = vi.fn();
    const handle = createErrorHandler({
      onRetryableError,
      onUserError,
      onSystemError,
      onUnknownError,
    });

    handle(err('rateLimited', 'Retry after 12 seconds'));

    expect(onRetryableError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rateLimited' }),
      12_000,
    );
    expect(onUserError).not.toHaveBeenCalled();
    expect(onSystemError).not.toHaveBeenCalled();
    expect(onUnknownError).not.toHaveBeenCalled();
  });

  it('routes user errors to onUserError', () => {
    const onUserError = vi.fn();
    const handle = createErrorHandler({ onUserError });
    handle(err('invalidInput', 'bad'));
    expect(onUserError).toHaveBeenCalledTimes(1);
  });

  it('routes remaining system errors to onSystemError', () => {
    const onSystemError = vi.fn();
    const handle = createErrorHandler({ onSystemError });
    handle(err('database'));
    expect(onSystemError).toHaveBeenCalledTimes(1);
  });

  it('routes anything that is not an OmnidexError to onUnknownError', () => {
    const onUnknownError = vi.fn();
    const onSystemError = vi.fn();
    const handle = createErrorHandler({ onUnknownError, onSystemError });
    const raw = new Error('plain JS error');
    handle(raw);
    expect(onUnknownError).toHaveBeenCalledWith(raw);
    expect(onSystemError).not.toHaveBeenCalled();
  });

  it('is a no-op (does not throw) when the matching callback is omitted', () => {
    const handle = createErrorHandler({});
    expect(() => handle(err('database'))).not.toThrow();
    expect(() => handle('not an error')).not.toThrow();
  });
});
