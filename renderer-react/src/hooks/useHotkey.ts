import { useEffect } from 'react';

interface Options {
  readonly key: string;
  readonly meta?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly handler: (event: KeyboardEvent) => void;
  readonly enabled?: boolean;
}

/**
 * Registers a global keyboard shortcut. Runs on `document` so it fires
 * regardless of focus. Set `meta: true` for Cmd on macOS or Ctrl elsewhere —
 * the helper checks whichever the platform uses.
 */
export function useHotkey({ key, meta, ctrl, shift, alt, handler, enabled = true }: Options): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      const metaOrCtrl = e.metaKey || e.ctrlKey;
      if (meta && !metaOrCtrl) return;
      if (ctrl && !e.ctrlKey) return;
      if (shift && !e.shiftKey) return;
      if (alt && !e.altKey) return;
      handler(e);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [key, meta, ctrl, shift, alt, handler, enabled]);
}
