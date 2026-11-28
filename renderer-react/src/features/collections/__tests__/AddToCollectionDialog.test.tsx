import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Adding to a collection from the dialog: failures are reported and leave the
 * dialog open, Enter can't create the collection twice, and a retry after a
 * failed add reuses the collection the first try created.
 */
const api = vi.hoisted(() => ({
  create: vi.fn(),
  add: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@/ipc/trpc', () => {
  const inv = { invalidate: vi.fn(async () => {}) };
  return {
    trpc: {
      useUtils: () => ({ collections: { list: inv, get: inv, assets: inv } }),
      collections: {
        list: {
          useQuery: () => ({
            isPending: false,
            isError: false,
            data: [{ id: 1, name: 'Kit', asset_count: 2 }],
          }),
        },
        create: { useMutation: () => ({ isPending: false, mutateAsync: api.create }) },
        addAssets: { useMutation: () => ({ isPending: false, mutateAsync: api.add }) },
      },
    },
  };
});
vi.mock('@/components/ui/toaster', () => ({
  toast: { error: api.error, success: api.success },
}));
// The Radix dialog portals and animates; a plain container keeps the test on
// the body's own behaviour.
vi.mock('@/components/ui/dialog', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Pass,
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});
vi.mock('@/stores/modals', () => ({
  useModals: (sel: (s: unknown) => unknown) =>
    sel({ addToCollection: { assetIds: [10, 11] }, closeAddToCollection: api.close }),
}));

import { AddToCollectionDialog } from '../AddToCollectionDialog';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const f of Object.values(api)) f.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<AddToCollectionDialog />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().endsWith(label));

async function click(label: string) {
  await act(async () => {
    button(label)?.click();
  });
}

function typeName(value: string): HTMLInputElement {
  const input = host.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

describe('AddToCollectionDialog', () => {
  it('reports a failed add and stays open', async () => {
    api.add.mockRejectedValueOnce(new Error('database is locked'));
    await click('Kit2');
    await click('Add');
    expect(api.error).toHaveBeenCalledWith("Couldn't add to collection: database is locked");
    expect(api.close).not.toHaveBeenCalled();
  });

  it('creates the collection once when Enter is pressed twice', async () => {
    let finish: (id: number) => void = () => {};
    api.create.mockReturnValue(new Promise<number>((r) => (finish = r)));
    api.add.mockResolvedValue(true);
    await click('Create new collection');
    const input = typeName('Rocks');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => finish(5));
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.add).toHaveBeenCalledTimes(1);
    expect(api.add).toHaveBeenCalledWith({ collection_id: 5, asset_ids: [10, 11] });
  });

  it('retries into the collection it already created', async () => {
    api.create.mockResolvedValue(5);
    api.add.mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(true);
    await click('Create new collection');
    typeName('Rocks');
    await click('Add');
    expect(api.error).toHaveBeenCalledWith('Created "Rocks" but couldn\'t add to it: busy');
    await click('Add');
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.add).toHaveBeenLastCalledWith({ collection_id: 5, asset_ids: [10, 11] });
    expect(api.success).toHaveBeenCalledWith('Added 2 assets to "Rocks"');
  });
});
