import { describe, expect, it } from 'vitest';
import {
  INITIAL_UPDATE_STATUS,
  isNoReleasesError,
  reduceUpdateStatus,
  summarizeError,
  type UpdateEvent,
  type UpdateStatus,
} from '../state';

const run = (events: UpdateEvent[], from: UpdateStatus = INITIAL_UPDATE_STATUS): UpdateStatus =>
  events.reduce(reduceUpdateStatus, from);

const checking: UpdateStatus = { phase: 'checking', trigger: 'manual' };
const available: UpdateStatus = { phase: 'available', version: '2.1.0' };
const downloading: UpdateStatus = {
  phase: 'downloading',
  version: '2.1.0',
  percent: 40,
  transferred: 40,
  total: 100,
};
const downloaded: UpdateStatus = { phase: 'downloaded', version: '2.1.0' };

describe('reduceUpdateStatus: the happy path', () => {
  it('walks check → available → download → downloaded', () => {
    expect(run([{ type: 'check-started', trigger: 'manual' }])).toEqual(checking);
    expect(run([{ type: 'update-available', version: '2.1.0' }], checking)).toEqual(available);
    expect(run([{ type: 'download-started' }], available)).toEqual({
      phase: 'downloading',
      version: '2.1.0',
      percent: 0,
      transferred: 0,
      total: 0,
    });
    expect(run([{ type: 'update-downloaded', version: '2.1.0' }], downloading)).toEqual(downloaded);
  });

  it('records when a check found nothing, and whether the repo has any release', () => {
    expect(run([{ type: 'update-not-available', at: 123 }], checking)).toEqual({
      phase: 'up-to-date',
      checkedAt: 123,
      noReleases: false,
    });
    expect(run([{ type: 'no-releases', at: 456 }], checking)).toEqual({
      phase: 'up-to-date',
      checkedAt: 456,
      noReleases: true,
    });
  });

  it('remembers who started the check', () => {
    expect(run([{ type: 'check-started', trigger: 'auto' }])).toEqual({
      phase: 'checking',
      trigger: 'auto',
    });
  });
});

describe('reduceUpdateStatus: events that do not fit the phase change nothing', () => {
  it('does not restart a check that is running, downloading, or downloaded', () => {
    for (const status of [checking, downloading, downloaded]) {
      expect(reduceUpdateStatus(status, { type: 'check-started', trigger: 'auto' })).toBe(status);
    }
  });

  it('does not let a late update-available clobber a finished download', () => {
    expect(reduceUpdateStatus(downloaded, { type: 'update-available', version: '9.9.9' })).toBe(
      downloaded,
    );
  });

  it('ignores progress outside a download', () => {
    const event: UpdateEvent = {
      type: 'download-progress',
      percent: 50,
      transferred: 5,
      total: 10,
    };
    for (const status of [INITIAL_UPDATE_STATUS, checking, available, downloaded]) {
      expect(reduceUpdateStatus(status, event)).toBe(status);
    }
  });

  it('ignores a download start with nothing to download', () => {
    for (const status of [INITIAL_UPDATE_STATUS, checking, downloaded]) {
      expect(reduceUpdateStatus(status, { type: 'download-started' })).toBe(status);
    }
  });

  it('does not turn an error outside a check or download into an error state', () => {
    for (const status of [INITIAL_UPDATE_STATUS, available, downloaded]) {
      expect(reduceUpdateStatus(status, { type: 'failed', message: 'late' })).toBe(status);
    }
  });
});

describe('reduceUpdateStatus: progress', () => {
  it('rounds to whole percents and clamps to 0–100', () => {
    const at = (percent: number) =>
      reduceUpdateStatus(downloading, {
        type: 'download-progress',
        percent,
        transferred: 1,
        total: 2,
      });
    expect(at(41.6)).toMatchObject({ percent: 42 });
    expect(at(140)).toMatchObject({ percent: 100 });
    expect(at(-5)).toMatchObject({ percent: 0 });
  });

  it('returns the same object when the whole percent has not moved', () => {
    // The updater fires many times a second; an unchanged percent must not
    // publish, or every tick is an IPC round trip for a pixel-identical bar.
    const next = reduceUpdateStatus(downloading, {
      type: 'download-progress',
      percent: 40.2,
      transferred: 41,
      total: 100,
    });
    expect(next).toBe(downloading);
  });
});

describe('reduceUpdateStatus: failure', () => {
  it('fails a check without a version', () => {
    expect(run([{ type: 'failed', message: 'offline' }], checking)).toEqual({
      phase: 'error',
      during: 'check',
      message: 'offline',
      version: null,
    });
  });

  it('fails a download and keeps the version so a retry knows the release', () => {
    expect(run([{ type: 'failed', message: 'signature' }], downloading)).toEqual({
      phase: 'error',
      during: 'download',
      message: 'signature',
      version: '2.1.0',
    });
  });

  it('retries a failed download, but not a failed check', () => {
    const downloadFailed = run([{ type: 'failed', message: 'x' }], downloading);
    expect(run([{ type: 'download-started' }], downloadFailed)).toMatchObject({
      phase: 'downloading',
      version: '2.1.0',
      percent: 0,
    });

    const checkFailed = run([{ type: 'failed', message: 'x' }], checking);
    expect(reduceUpdateStatus(checkFailed, { type: 'download-started' })).toBe(checkFailed);
  });

  it('lets a failed check be checked again', () => {
    const failed = run([{ type: 'failed', message: 'x' }], checking);
    expect(run([{ type: 'check-started', trigger: 'manual' }], failed)).toEqual(checking);
  });
});

describe('summarizeError', () => {
  it('keeps the first line of a stacked error', () => {
    const err = new Error('net::ERR_INTERNET_DISCONNECTED\n    at ClientRequest.<anonymous>');
    expect(summarizeError(err)).toBe('net::ERR_INTERNET_DISCONNECTED');
  });

  it('caps a long first line', () => {
    const out = summarizeError(new Error('x'.repeat(500)));
    expect(out).toHaveLength(198);
    expect(out.endsWith('…')).toBe(true);
  });

  it('replaces a checksum mismatch, which quotes two long digests, with one sentence', () => {
    const digest = 'x'.repeat(88);
    expect(
      summarizeError(new Error(`sha512 checksum mismatch, expected ${digest}, got ${digest}`)),
    ).toBe('The downloaded file did not match its checksum, so it was discarded.');
  });

  it('accepts a bare string and never returns an empty message', () => {
    expect(summarizeError('plain')).toBe('plain');
    expect(summarizeError(new Error(''))).toBe('Unknown error');
    expect(summarizeError('\n\n')).toBe('Unknown error');
  });
});

describe('isNoReleasesError', () => {
  it('matches the 404 GitHub returns for a repository with no releases', () => {
    expect(
      isNoReleasesError(
        new Error(
          'Cannot download "https://github.com/Umbra-Lab/Omnidex/releases.atom", status 404: Not Found',
        ),
      ),
    ).toBe(true);
  });

  it('matches an empty feed', () => {
    expect(isNoReleasesError(new Error('No published versions on GitHub'))).toBe(true);
  });

  it('does not swallow other failures, including a 404 for some other URL', () => {
    expect(isNoReleasesError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false);
    expect(isNoReleasesError(new Error('status 404 for latest.yml'))).toBe(false);
    expect(isNoReleasesError(new Error('status 403: rate limit exceeded'))).toBe(false);
  });
});
