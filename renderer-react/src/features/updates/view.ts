import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../electron/main/trpc/router';

/**
 * Presentation rules for the update flow, kept out of the components so the
 * copy and the "which buttons when" table can be tested without rendering.
 * The state itself is owned by `electron/main/updater.ts`; nothing here decides
 * whether an update is available or installable.
 */

export type UpdateState = inferRouterOutputs<AppRouter>['updates']['state'];
export type UpdateStatus = UpdateState['status'];

export type UpdateAction = 'download' | 'retry-download' | 'install' | 'view-release';

/** Phases the app-wide banner surfaces. A failed check stays in Settings → About. */
export function showsBanner(status: UpdateStatus): boolean {
  switch (status.phase) {
    case 'available':
    case 'downloading':
    case 'downloaded':
      return true;
    case 'error':
      return status.during === 'download';
    default:
      return false;
  }
}

/**
 * Identity of what the banner is showing. Dismissing stores this key, so a
 * dismissed "available" banner returns when the same update finishes
 * downloading, and a new error is not hidden by an old dismissal.
 */
export function bannerKey(status: UpdateStatus): string {
  switch (status.phase) {
    case 'available':
    case 'downloading':
    case 'downloaded':
      // Downloading is not its own key: progress ticks must not resurrect a
      // dismissed banner, and the phase change to downloaded should.
      return `${status.phase === 'downloading' ? 'available' : status.phase}:${status.version}`;
    case 'error':
      return `error:${status.version ?? ''}:${status.message}`;
    default:
      return status.phase;
  }
}

/** The actions a status offers, in display order. The first is the primary one. */
export function actionsFor(status: UpdateStatus): readonly UpdateAction[] {
  switch (status.phase) {
    case 'available':
      return ['download', 'view-release'];
    case 'downloaded':
      return ['install'];
    case 'error':
      return status.during === 'download' ? ['retry-download', 'view-release'] : [];
    default:
      return [];
  }
}

export const ACTION_LABEL: Record<UpdateAction, string> = {
  download: 'Download update',
  'retry-download': 'Try again',
  install: 'Restart now',
  'view-release': 'View release',
};

/** One line for the app-wide banner. Progress is drawn beside it, not spelled here. */
export function bannerText(status: UpdateStatus): string {
  switch (status.phase) {
    case 'available':
      return `Omnidex ${status.version} is available.`;
    case 'downloading':
      return `Downloading Omnidex ${status.version}`;
    case 'downloaded':
      return `Omnidex ${status.version} is ready to install.`;
    case 'error':
      return `The download failed. ${status.message}`;
    default:
      return '';
  }
}

/** The status line in Settings → About. */
export function statusText(state: UpdateState, formatTime: (ms: number) => string): string {
  if (!state.supported) return state.unsupportedReason ?? 'Update checks are unavailable.';
  const { status } = state;
  switch (status.phase) {
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking GitHub…';
    case 'up-to-date':
      return status.noReleases
        ? 'No releases are published yet.'
        : `You have the latest version. Checked at ${formatTime(status.checkedAt)}.`;
    case 'available':
      return `Version ${status.version} is available.`;
    case 'downloading':
      return `Downloading version ${status.version}…`;
    case 'downloaded':
      return `Version ${status.version} is ready. It installs when you quit Omnidex.`;
    case 'error':
      return status.during === 'download'
        ? `The download failed. ${status.message}`
        : `Could not check for updates. ${status.message}`;
  }
}

/** True while a request to GitHub is in flight. */
export function isBusy(status: UpdateStatus): boolean {
  return status.phase === 'checking' || status.phase === 'downloading';
}
