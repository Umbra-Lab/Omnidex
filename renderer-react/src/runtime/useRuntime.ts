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
