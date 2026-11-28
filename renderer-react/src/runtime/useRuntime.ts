import { useSyncExternalStore } from 'react';

export interface RuntimeInfo {
  kind: 'electron' | 'browser';
  platform: string;
  versions: {
    electron?: string;
    chrome?: string;
    node?: string;
  };
}

function detect(): RuntimeInfo {
  const bridge = (globalThis as { omnidex?: unknown }).omnidex;
  if (bridge && typeof bridge === 'object' && 'runtime' in bridge) {
    const b = bridge as {
      runtime: string;
      platform: string;
      versions: RuntimeInfo['versions'];
    };
    return { kind: 'electron', platform: b.platform, versions: b.versions };
  }
  return { kind: 'browser', platform: 'web', versions: {} };
}

const snapshot = detect();
const subscribe = () => () => {};
const getSnapshot = () => snapshot;

export function useRuntime(): RuntimeInfo {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The menu label for opening an asset's folder in the system file manager, in
 * each platform's own words. "Reveal in Finder" on Windows named an app that
 * isn't there. It says "Open" because that is what happens: an asset's path is
 * its pack folder, and `shell:open-file-location` opens a folder itself rather
 * than selecting it in its parent.
 */
export function revealLabel(platform: string = snapshot.platform): string {
  if (platform === 'darwin') return 'Open in Finder';
  if (platform === 'win32') return 'Open in File Explorer';
  return 'Open Folder';
}
