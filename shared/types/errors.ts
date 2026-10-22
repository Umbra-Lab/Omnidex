/**
 * Omnidex structured error types for frontend error handling
 *
 * These types match the Rust OmnidexError enum serialization format.
 * Errors from Tauri commands serialize as: { "kind": "<variant>", "message": "<text>" }
 *
 * @example
 * ```typescript
 * import { invoke } from '$lib/runtime';
 * import { isOmnidexError, isRetryable, getRetryDelay } from '$lib/types/errors';
 *
 * try {
 *   const asset = await invoke<Asset>('get_asset_details', { id });
 * } catch (e) {
 *   if (isOmnidexError(e)) {
 *     if (e.kind === 'notFound') {
 *       showToast('Asset not found');
 *     } else if (isRetryable(e)) {
 *       setTimeout(() => retry(), getRetryDelay(e));
 *     }
 *   }
 * }
 * ```
 */

/**
 * All possible error kinds from the Omnidex backend
 */
export type OmnidexErrorKind =
  | 'database'
  | 'fileSystem'
  | 'network'
  | 'parse'
  | 'notFound'
  | 'config'
  | 'externalService'
  | 'initialization'
  | 'invalidInput'
  | 'cache'
  | 'auth'
  | 'internal'
  | 'rateLimited'
  | 'migration'
  | 'backup'
  | 'search';

/**
 * Omnidex structured error type from Tauri commands
 */
export interface OmnidexError {
  /**
   * Error category for programmatic handling
   */
  kind: OmnidexErrorKind;
  /**
   * Human-readable error message
   */
  message: string;
}

/**
 * Errors that may succeed on retry
 */
const RETRYABLE_ERRORS: OmnidexErrorKind[] = ['network', 'externalService', 'rateLimited'];

/**
 * Errors caused by user input or action
 */
const USER_ERRORS: OmnidexErrorKind[] = ['invalidInput', 'notFound', 'auth'];

/**
 * All valid error kinds for type guard validation
 */
const VALID_ERROR_KINDS: OmnidexErrorKind[] = [
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

/**
 * Type guard to check if an unknown error is an OmnidexError
 *
 * Use this when catching errors from Tauri invoke calls.
 *
 * @example
 * ```typescript
 * try {
 *   await invoke('some_command');
 * } catch (e) {
 *   if (isOmnidexError(e)) {
 *     // e is now typed as OmnidexError
 *     console.log(e.kind, e.message);
 *   } else {
 *     console.error('Unexpected error:', e);
 *   }
 * }
 * ```
 */
export function isOmnidexError(error: unknown): error is OmnidexError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as Record<string, unknown>;

  return (
    typeof candidate.kind === 'string' &&
    typeof candidate.message === 'string' &&
    VALID_ERROR_KINDS.includes(candidate.kind as OmnidexErrorKind)
  );
}

/**
 * Check if an error is potentially recoverable via retry
 *
 * Returns true for network, externalService, and rateLimited errors.
 *
 * @example
 * ```typescript
 * if (isRetryable(error)) {
 *   setTimeout(() => retryOperation(), getRetryDelay(error));
 * }
 * ```
 */
export function isRetryable(error: OmnidexError): boolean {
  return RETRYABLE_ERRORS.includes(error.kind);
}

/**
 * Check if an error is due to user input/action
 *
 * User errors typically don't need retry - they need
 * user correction or different input.
 *
 * @example
 * ```typescript
 * if (isUserError(error)) {
 *   showValidationError(error.message);
 * } else {
 *   showSystemError(error.message);
 * }
 * ```
 */
export function isUserError(error: OmnidexError): boolean {
  return USER_ERRORS.includes(error.kind);
}

/**
 * Get recommended retry delay in milliseconds
 *
 * For rateLimited errors, extracts the server-specified delay.
 * For other retryable errors, returns sensible defaults.
 *
 * @returns Delay in milliseconds
 *
 * @example
 * ```typescript
 * const delay = getRetryDelay(error);
 * setTimeout(() => retryOperation(), delay);
 * ```
 */
export function getRetryDelay(error: OmnidexError): number {
  if (error.kind === 'rateLimited') {
    // Extract seconds from message like "Retry after 60 seconds"
    const match = error.message.match(/(\d+)\s*seconds?/i);
    if (match) {
      return parseInt(match[1], 10) * 1000;
    }
    return 60000; // Default 60s for rate limiting
  }

  // Default delays by error type
  switch (error.kind) {
    case 'network':
      return 5000; // 5 seconds for network issues
    case 'externalService':
      return 10000; // 10 seconds for external services
    default:
      return 5000; // 5 second default
  }
}

/**
 * Get a user-friendly error message
 *
 * Transforms technical error messages into user-appropriate text.
 * For user errors, returns the original message.
 * For system errors, returns a generic message to avoid exposing internals.
 *
 * @example
 * ```typescript
 * showToast(getErrorMessage(error));
 * ```
 */
export function getErrorMessage(error: OmnidexError): string {
  // User errors - show the actual message
  if (isUserError(error)) {
    return error.message;
  }

  // System errors - provide friendly messages
  switch (error.kind) {
    case 'database':
      return 'A database error occurred. Please try again.';
    case 'fileSystem':
      return 'Unable to access the file system. Check permissions.';
    case 'network':
      return 'Network connection failed. Check your internet connection.';
    case 'externalService':
      return 'External service unavailable. Please try again later.';
    case 'rateLimited':
      return `Too many requests. ${error.message}`;
    case 'migration':
      return 'Database upgrade failed. A backup has been created.';
    case 'backup':
      return 'Backup operation failed. Check disk space.';
    case 'search':
      return 'Search failed. Please try a different query.';
    case 'initialization':
      return 'Application failed to start properly.';
    case 'config':
      return 'Configuration error. Please check settings.';
    case 'cache':
      return 'Cache error. Clearing cache may help.';
    case 'parse':
      return 'Failed to process data. The format may be invalid.';
    default:
      return 'An unexpected error occurred.';
  }
}

/**
 * Create an error handler with callbacks for different error types
 *
 * @example
 * ```typescript
 * const handler = createErrorHandler({
 *   onRetryableError: (error, delay) => {
 *     showRetryPrompt(`Retrying in ${delay / 1000}s...`);
 *   },
 *   onUserError: (error) => {
 *     showValidationError(error.message);
 *   },
 *   onSystemError: (error) => {
 *     showErrorDialog(getErrorMessage(error));
 *   },
 * });
 *
 * try {
 *   await invoke('command');
 * } catch (e) {
 *   handler(e);
 * }
 * ```
 */
export function createErrorHandler(handlers: {
  onRetryableError?: (error: OmnidexError, retryDelay: number) => void;
  onUserError?: (error: OmnidexError) => void;
  onSystemError?: (error: OmnidexError) => void;
  onUnknownError?: (error: unknown) => void;
}) {
  return (error: unknown): void => {
    if (!isOmnidexError(error)) {
      handlers.onUnknownError?.(error);
      return;
    }

    if (isRetryable(error)) {
      handlers.onRetryableError?.(error, getRetryDelay(error));
    } else if (isUserError(error)) {
      handlers.onUserError?.(error);
    } else {
      handlers.onSystemError?.(error);
    }
  };
}
