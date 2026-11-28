import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ summary: [] as { kind: string; count: number }[] }));

vi.mock('@/ipc/trpc', () => ({
  trpc: {
    libraryHealth: {
      summary: { useQuery: () => ({ data: api.summary, isError: false }) },
      list: { useQuery: () => ({ data: [], isLoading: false }) },
    },
  },
}));

import { LibraryHealthView } from '../LibraryHealthView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

describe('library health skipped count', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('counts only what the scan left out, not indexed packs with a warning', async () => {
    api.summary = [
      { kind: 'thumbnail-failed', count: 55 },
      { kind: 'path-near-max-length', count: 3 },
      { kind: 'archive-only', count: 2 },
      { kind: 'unreadable-folder', count: 1 },
    ];
    await act(async () => root.render(<LibraryHealthView />));
    expect(container.textContent).toContain('3 skipped');
    expect(container.textContent).not.toContain('61 skipped');
  });

  it('says nothing was skipped when only warnings exist', async () => {
    api.summary = [{ kind: 'thumbnail-failed', count: 55 }];
    await act(async () => root.render(<LibraryHealthView />));
    expect(container.textContent).toContain('0 skipped');
    expect(container.textContent).toContain('55');
  });
});
