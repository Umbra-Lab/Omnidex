import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  tags: { status: 'pending', data: undefined } as {
    status: 'pending' | 'success' | 'error';
    data: string[] | undefined;
    /** False while showing only cached data from before this opening. */
    fresh?: boolean;
  },
  queryOpts: [] as unknown[],
  setTags: vi.fn(),
  listeners: new Set<() => void>(),
}));

/** Swap the getTags query result and re-render whoever reads it. */
function setTagsQuery(next: typeof api.tags) {
  api.tags = next;
  for (const l of api.listeners) l();
}

vi.mock('@/ipc/trpc', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (l: () => void) => {
    api.listeners.add(l);
    return () => api.listeners.delete(l);
  };
  return {
    trpc: {
      useUtils: () => ({ assets: { invalidate: vi.fn() } }),
      assets: {
        getTags: {
          useQuery: (_input: unknown, opts: unknown) => {
            api.queryOpts.push(opts);
            return {
              ...useSyncExternalStore(subscribe, () => api.tags),
              isFetchedAfterMount: api.tags.status !== 'pending' && api.tags.fresh !== false,
              isPending: api.tags.status === 'pending',
              isSuccess: api.tags.status === 'success',
              isError: api.tags.status === 'error',
            };
          },
        },
        setTags: { useMutation: () => ({ mutate: api.setTags }) },
        addTags: { useMutation: () => ({ mutate: vi.fn() }) },
      },
    },
  };
});
vi.mock('@/features/collections/AddToCollectionDialog', () => ({
  AddToCollectionDialog: () => null,
}));
vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useModals } from '@/stores/modals';
import { ModalHost } from '../ModalHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => root.render(<ModalHost />));
}

function saveButton(): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Save');
}

describe('single-asset tagging', () => {
  beforeEach(() => {
    api.tags = { status: 'pending', data: undefined };
    api.queryOpts = [];
    api.setTags.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => useModals.getState().closeTagging());
    await act(async () => root.unmount());
    container.remove();
  });

  it('does not offer a replacing save before the asset’s tags have loaded', async () => {
    await render();
    await act(async () => useModals.getState().openTagging(7));
    expect(document.body.textContent).not.toContain('No tags yet');
    expect(saveButton()?.disabled ?? true).toBe(true);
  });

  it('seeds the modal with the loaded tags once they arrive', async () => {
    await render();
    await act(async () => useModals.getState().openTagging(7));
    const dialogWhileLoading = document.body.querySelector('[role="dialog"]');
    await act(async () => setTagsQuery({ status: 'success', data: ['hero', 'forest'] }));
    // Same dialog node: the tags fill in without remounting (and re-animating) it.
    expect(document.body.querySelector('[role="dialog"]')).toBe(dialogWhileLoading);
    expect(document.body.textContent).toContain('hero');
    expect(document.body.textContent).toContain('forest');
    const save = saveButton();
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    expect(api.setTags).toHaveBeenCalledWith({ assetId: 7, tags: ['hero', 'forest'] });
  });

  it('blocks saving when the tags failed to load', async () => {
    api.tags = { status: 'error', data: undefined };
    await render();
    await act(async () => useModals.getState().openTagging(7));
    expect(document.body.textContent).not.toContain('No tags yet');
    expect(saveButton()?.disabled ?? true).toBe(true);
    expect(api.setTags).not.toHaveBeenCalled();
  });

  it('waits for a fresh fetch instead of seeding from a stale cached list', async () => {
    // Cached from an earlier opening; a FAB sync has since added "props".
    api.tags = { status: 'success', data: ['hero'], fresh: false };
    await render();
    await act(async () => useModals.getState().openTagging(7));
    expect(api.queryOpts.at(-1)).toMatchObject({ refetchOnMount: 'always' });
    expect(saveButton()?.disabled ?? true).toBe(true);

    await act(async () => setTagsQuery({ status: 'success', data: ['hero', 'props'] }));
    const save = saveButton();
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    expect(api.setTags).toHaveBeenCalledWith({ assetId: 7, tags: ['hero', 'props'] });
  });

  it('blocks saving when the refetch failed, even with a cached list', async () => {
    api.tags = { status: 'error', data: ['hero'] };
    await render();
    await act(async () => useModals.getState().openTagging(7));
    expect(saveButton()?.disabled ?? true).toBe(true);
  });
});
