import { describe, expect, it } from 'vitest';
import {
  ACTION_LABEL,
  actionsFor,
  bannerKey,
  bannerText,
  isBusy,
  showsBanner,
  statusText,
  type UpdateState,
  type UpdateStatus,
} from '../view';

const available: UpdateStatus = { phase: 'available', version: '2.1.0' };
const downloading: UpdateStatus = {
  phase: 'downloading',
  version: '2.1.0',
  percent: 42,
  transferred: 42,
  total: 100,
};
const downloaded: UpdateStatus = { phase: 'downloaded', version: '2.1.0' };
const downloadFailed: UpdateStatus = {
  phase: 'error',
  during: 'download',
  message: 'Code signature did not pass validation',
  version: '2.1.0',
};
const checkFailed: UpdateStatus = {
  phase: 'error',
  during: 'check',
  message: 'net::ERR_INTERNET_DISCONNECTED',
  version: null,
};
const upToDate: UpdateStatus = { phase: 'up-to-date', checkedAt: 0, noReleases: false };

const all: UpdateStatus[] = [
  { phase: 'idle' },
  { phase: 'checking', trigger: 'manual' },
  upToDate,
  available,
  downloading,
  downloaded,
  downloadFailed,
  checkFailed,
];

const stateOf = (status: UpdateStatus, over: Partial<UpdateState> = {}): UpdateState => ({
  supported: true,
  unsupportedReason: null,
  currentVersion: '2.0.7',
  autoCheck: false,
  releaseUrl: 'https://github.com/Umbra-Lab/Omnidex/releases/latest',
  status,
  ...over,
});

const time = (ms: number) => `t${ms}`;

describe('showsBanner', () => {
  it('interrupts only for an update that needs a decision', () => {
    expect(all.filter(showsBanner).map((s) => s.phase)).toEqual([
      'available',
      'downloading',
      'downloaded',
      'error',
    ]);
    expect(showsBanner(downloadFailed)).toBe(true);
  });

  it('keeps a failed check in Settings; a background check must not nag', () => {
    expect(showsBanner(checkFailed)).toBe(false);
  });
});

describe('bannerKey', () => {
  it('does not resurrect a dismissed banner on every progress tick', () => {
    expect(bannerKey(downloading)).toBe(bannerKey(available));
    expect(bannerKey({ ...downloading, percent: 90 })).toBe(bannerKey(downloading));
  });

  it('brings a dismissed banner back when the download finishes', () => {
    expect(bannerKey(downloaded)).not.toBe(bannerKey(available));
  });

  it('does not let an old dismissal hide a newer version or a new error', () => {
    expect(bannerKey({ phase: 'available', version: '2.2.0' })).not.toBe(bannerKey(available));
    expect(bannerKey({ ...downloadFailed, message: 'ETIMEDOUT' })).not.toBe(
      bannerKey(downloadFailed),
    );
  });
});

describe('actionsFor', () => {
  it('offers the right buttons per phase, primary first', () => {
    expect(actionsFor(available)).toEqual(['download', 'view-release']);
    expect(actionsFor(downloaded)).toEqual(['install']);
    expect(actionsFor(downloadFailed)).toEqual(['retry-download', 'view-release']);
  });

  it('offers nothing while busy, up to date, or after a failed check', () => {
    for (const status of [
      { phase: 'idle' } as UpdateStatus,
      { phase: 'checking', trigger: 'auto' } as UpdateStatus,
      upToDate,
      downloading,
      checkFailed,
    ]) {
      expect(actionsFor(status)).toEqual([]);
    }
  });
});

describe('copy', () => {
  it('keeps every button label to three words or fewer, in sentence case', () => {
    for (const label of Object.values(ACTION_LABEL)) {
      expect(label.split(' ').length, label).toBeLessThanOrEqual(3);
      expect(label, label).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
    }
  });

  it('names the version in the banner and puts the failure reason after the headline', () => {
    expect(bannerText(available)).toBe('Omnidex 2.1.0 is available.');
    expect(bannerText(downloaded)).toBe('Omnidex 2.1.0 is ready to install.');
    expect(bannerText(downloadFailed)).toBe(
      'The download failed. Code signature did not pass validation',
    );
  });

  it('describes every phase in the About status line', () => {
    expect(statusText(stateOf({ phase: 'idle' }), time)).toBe('Not checked yet.');
    expect(statusText(stateOf({ phase: 'checking', trigger: 'manual' }), time)).toBe(
      'Checking GitHub…',
    );
    expect(statusText(stateOf({ ...upToDate, checkedAt: 7 }), time)).toBe(
      'You have the latest version. Checked at t7.',
    );
    expect(statusText(stateOf({ ...upToDate, noReleases: true }), time)).toBe(
      'No releases are published yet.',
    );
    expect(statusText(stateOf(available), time)).toBe('Version 2.1.0 is available.');
    expect(statusText(stateOf(downloading), time)).toBe('Downloading version 2.1.0…');
    expect(statusText(stateOf(downloaded), time)).toBe(
      'Version 2.1.0 is ready. It installs when you quit Omnidex.',
    );
    expect(statusText(stateOf(checkFailed), time)).toBe(
      'Could not check for updates. net::ERR_INTERNET_DISCONNECTED',
    );
    expect(statusText(stateOf(downloadFailed), time)).toBe(
      'The download failed. Code signature did not pass validation',
    );
  });

  it('explains an unsupported build instead of showing a stale phase', () => {
    const dev = stateOf(
      { phase: 'idle' },
      { supported: false, unsupportedReason: 'Update checks run only in installed builds.' },
    );
    expect(statusText(dev, time)).toBe('Update checks run only in installed builds.');
  });
});

describe('isBusy', () => {
  it('is true only while a request to GitHub is in flight', () => {
    expect(all.filter(isBusy).map((s) => s.phase)).toEqual(['checking', 'downloading']);
  });
});
