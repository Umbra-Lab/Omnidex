import { useEffect } from 'react';

/**
 * Subscribe to a channel emitted by the Electron main process via
 * `webContents.send(channel, payload)`. The preload exposes
 * `window.omnidex.events.on(channel, handler)` which returns an unlisten
 * function; we call it on unmount.
 */
export function useIpcEvent<T>(channel: string, handler: (payload: T) => void): void {
  useEffect(() => {
    const bridge = (
      globalThis as {
        omnidex?: { events?: { on: (c: string, h: (p: unknown) => void) => () => void } };
      }
    ).omnidex;
    if (!bridge?.events?.on) return;
    const off = bridge.events.on(channel, (payload) => handler(payload as T));
    return off;
  }, [channel, handler]);
}
