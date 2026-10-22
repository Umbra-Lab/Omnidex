/**
 * Update-flow state machine. Pure: no Electron, no electron-updater, no clock.
 * `electron/main/updater.ts` translates updater events and user actions into
 * `UpdateEvent`s and publishes whatever `reduceUpdateStatus` returns.
 *
 * ```
 *  idle ─► checking ─► up-to-date
 *             │  └────► available ─► downloading ─► downloaded
 *             │                          │
 *             └──► error ◄───────────────┘   (error during download can retry)
 * ```
 *
 * The reducer is deliberately strict about where an event may land. A late
 * `update-available` must not clobber a finished download, and a second check
 * must not reset a download in flight, so an event that does not fit the
 * current phase returns the same object and the caller publishes nothing.
 */

export type UpdateTrigger = 'manual' | 'auto';

export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking'; trigger: UpdateTrigger }
  | { phase: 'up-to-date'; checkedAt: number; noReleases: boolean }
  | { phase: 'available'; version: string }
  | {
      phase: 'downloading';
      version: string;
      /** Whole percent, 0–100. */
      percent: number;
      transferred: number;
      total: number;
    }
  | { phase: 'downloaded'; version: string }
  | {
      phase: 'error';
      during: 'check' | 'download';
      message: string;
      /** Set for a download error, so a retry knows which release it was. */
      version: string | null;
    };

export type UpdateEvent =
  | { type: 'check-started'; trigger: UpdateTrigger }
  | { type: 'update-available'; version: string }
  | { type: 'update-not-available'; at: number }
  | { type: 'no-releases'; at: number }
  | { type: 'download-started' }
  | { type: 'download-progress'; percent: number; transferred: number; total: number }
  | { type: 'update-downloaded'; version: string }
  | { type: 'failed'; message: string };

export const INITIAL_UPDATE_STATUS: UpdateStatus = { phase: 'idle' };

export function reduceUpdateStatus(status: UpdateStatus, event: UpdateEvent): UpdateStatus {
  switch (event.type) {
    case 'check-started':
      // A check never interrupts a download or a downloaded update.
      if (
        status.phase === 'checking' ||
        status.phase === 'downloading' ||
        status.phase === 'downloaded'
      ) {
        return status;
      }
      return { phase: 'checking', trigger: event.trigger };

    case 'update-available':
      if (status.phase !== 'checking') return status;
      return { phase: 'available', version: event.version };

    case 'update-not-available':
      if (status.phase !== 'checking') return status;
      return { phase: 'up-to-date', checkedAt: event.at, noReleases: false };

    case 'no-releases':
      if (status.phase !== 'checking') return status;
      return { phase: 'up-to-date', checkedAt: event.at, noReleases: true };

    case 'download-started': {
      if (status.phase === 'available') {
        return {
          phase: 'downloading',
          version: status.version,
          percent: 0,
          transferred: 0,
          total: 0,
        };
      }
      // Retry after a failed download: electron-updater still holds the release.
      if (status.phase === 'error' && status.during === 'download' && status.version) {
        return {
          phase: 'downloading',
          version: status.version,
          percent: 0,
          transferred: 0,
          total: 0,
        };
      }
      return status;
    }

    case 'download-progress': {
      if (status.phase !== 'downloading') return status;
      const percent = Math.max(0, Math.min(100, Math.round(event.percent)));
      // The updater reports many times a second; the UI only shows whole
      // percents, so an unchanged percent is not worth an IPC round trip.
      if (percent === status.percent) return status;
      return { ...status, percent, transferred: event.transferred, total: event.total };
    }

    case 'update-downloaded':
      if (status.phase !== 'downloading' && status.phase !== 'available') return status;
      return { phase: 'downloaded', version: event.version };

    case 'failed':
      if (status.phase === 'checking') {
        return { phase: 'error', during: 'check', message: event.message, version: null };
      }
      if (status.phase === 'downloading') {
        return {
          phase: 'error',
          during: 'download',
          message: event.message,
          version: status.version,
        };
      }
      return status;
  }
}

/**
 * First line of an updater error, capped. electron-updater errors carry a stack
 * and, for HTTP failures, the full response headers; none of that belongs in a
 * status line. A checksum mismatch quotes both 88-character digests, which a
 * user cannot act on, so it becomes one sentence.
 */
export function summarizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split('\n')[0]?.trim() ?? '';
  if (!first) return 'Unknown error';
  if (first.includes('checksum mismatch')) {
    return 'The downloaded file did not match its checksum, so it was discarded.';
  }
  return first.length > 200 ? `${first.slice(0, 197)}…` : first;
}

/**
 * GitHub answers `releases.atom` with a 404 for a repository that has never
 * published a release, and electron-updater raises `No published versions` for
 * an empty feed. Both mean "nothing to update to yet", not "the check broke".
 */
export function isNoReleasesError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return (
    (raw.includes('404') && raw.includes('releases.atom')) || raw.includes('No published versions')
  );
}
