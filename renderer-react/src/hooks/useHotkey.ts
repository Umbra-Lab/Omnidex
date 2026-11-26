import { useEffect } from 'react';

interface Options {
  readonly key: string;
  readonly meta?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly handler: (event: KeyboardEvent) => void;
  readonly enabled?: boolean;
  /**
   * Also fire while focus is in a text field, select or contenteditable.
   * Off by default: a bare-letter shortcut must never act while someone is
   * typing, and Ctrl/Cmd+A in a field means "select this text". Only a
   * shortcut that is meant to work from anywhere (the command palette) opts in.
   */
  readonly allowInInputs?: boolean;
}

/** True when the key event is aimed at something the user types into. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  // jsdom does not implement isContentEditable; the attribute walk covers it.
  return target.closest('[contenteditable]:not([contenteditable="false"])') != null;
}

/**
 * Registers a global keyboard shortcut on `document`. Set `meta: true` for Cmd
 * on macOS or Ctrl elsewhere — the helper checks whichever the platform uses.
 *
 * It stays out of the way of typing: it does not fire while focus is in an
 * editable element (unless `allowInInputs`), and it does not fire when Ctrl,
 * Cmd or Alt is held but the shortcut did not ask for it, so `r` never fires
 * on Ctrl+R. Shift is not checked unless asked for, since it only changes case.
 */
export function useHotkey({
  key,
  meta,
  ctrl,
  shift,
  alt,
  handler,
  enabled = true,
  allowInInputs = false,
}: Options): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      const metaOrCtrl = e.metaKey || e.ctrlKey;
      if (meta && !metaOrCtrl) return;
      if (ctrl && !e.ctrlKey) return;
      if (shift && !e.shiftKey) return;
      if (alt && !e.altKey) return;
      // Extra modifiers the shortcut did not ask for mean a different chord.
      if (!meta && !ctrl && metaOrCtrl) return;
      if (!meta && ctrl && e.metaKey) return;
      if (!alt && e.altKey) return;
      if (!allowInInputs && isEditableTarget(e.target)) return;
      handler(e);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [key, meta, ctrl, shift, alt, handler, enabled, allowInInputs]);
}
