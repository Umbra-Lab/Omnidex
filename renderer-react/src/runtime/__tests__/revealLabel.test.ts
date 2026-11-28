import { describe, expect, it } from 'vitest';
import { revealLabel } from '../useRuntime';

describe('revealLabel', () => {
  it('names each platform’s own file manager', () => {
    expect(revealLabel('darwin')).toBe('Open in Finder');
    expect(revealLabel('win32')).toBe('Open in File Explorer');
    expect(revealLabel('linux')).toBe('Open Folder');
  });
});
