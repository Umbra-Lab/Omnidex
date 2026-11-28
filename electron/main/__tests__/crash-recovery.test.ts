import { describe, expect, it } from 'vitest';
import { CRASH_LOOP_COUNT, crashDialogChoice, crashDialogOptions } from '../crash-recovery';

describe('renderer crash dialog', () => {
  it('offers Reload or Close for a one-off crash, and Close really closes', () => {
    const opts = crashDialogOptions('oom', false);
    expect(opts.buttons).toEqual(['Reload', 'Close']);
    expect(crashDialogChoice(0, false)).toBe('reload');
    expect(crashDialogChoice(1, false)).toBe('close');
  });

  it('stops leading with Reload once the window is crash-looping', () => {
    const opts = crashDialogOptions('oom', true);
    expect(opts.buttons[opts.defaultId]).toBe('Show log');
    expect(opts.detail).toContain(String(CRASH_LOOP_COUNT));
    expect(crashDialogChoice(0, true)).toBe('logs');
    expect(crashDialogChoice(opts.cancelId, true)).toBe('close');
    expect(crashDialogChoice(2, true)).toBe('reload');
  });
});
