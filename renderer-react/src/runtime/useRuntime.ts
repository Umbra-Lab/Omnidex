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
 * The menu label for showing a file in the system file manager, in each
 * platform's own words. "Reveal in Finder" on Windows names an app that isn't
 * there.
 */
export function revealLabel(platform: string = snapshot.platform): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Reveal in File Explorer';
  return 'Open Containing Folder';
}
