import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Renaming a collection from its header. Enter or blur saves, Escape throws
 * the edit away, and a blank or unchanged name is not sent.
 */
const api = vi.hoisted(() => ({
  rename: vi.fn(),
  name: 'Rocks' as string,
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#/collections">{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ collectionId: '3' }),
}));
vi.mock('@/ipc/trpc', () => {
  const inv = { invalidate: vi.fn() };
  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  return {
    trpc: {
      useUtils: () => ({ collections: { get: inv, list: inv, assets: inv }, assets: inv }),
      collections: {
        get: { useQuery: () => ({ data: { id: 3, name: api.name }, isPending: false }) },
        assets: { useQuery: () => ({ data: [], isPending: false }) },
        removeAssets: { useMutation: mutation },
        delete: { useMutation: mutation },
        rename: { useMutation: () => ({ isPending: false, mutate: api.rename }) },
      },
      assets: { setFavorite: { useMutation: mutation } },
    },
  };
});
vi.mock('@/features/assets/AssetGrid', () => ({ AssetGrid: () => null }));
vi.mock('@/features/assets/InspectorPanel', () => ({ InspectorPanel: () => null }));
vi.mock('@/hooks/useNativeContextMenu', () => ({ useNativeContextMenu: () => vi.fn() }));

import { CollectionDetail } from '../CollectionDetail';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.rename.mockReset();
  api.name = 'Rocks';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<CollectionDetail />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

function startRename(): HTMLInputElement {
  act(() => button('Rename')?.click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Collection name"]');
  if (!input) throw new Error('no name input');
  return input;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(input: HTMLInputElement, k: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

describe('CollectionDetail rename', () => {
  it('starts from the current name', () => {
    expect(startRename().value).toBe('Rocks');
    expect(button('Rename')).toBeUndefined();
  });

  it('saves the trimmed name once on Enter', () => {
    const input = startRename();
    type(input, '  Cliffs  ');
    key(input, 'Enter');
    act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(api.rename).toHaveBeenCalledTimes(1);
    expect(api.rename).toHaveBeenCalledWith({ id: 3, name: 'Cliffs' });
    expect(host.querySelector('input')).toBeNull();
  });

  it('saves on blur', () => {
    const input = startRename();
    type(input, 'Cliffs');
    act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(api.rename).toHaveBeenCalledWith({ id: 3, name: 'Cliffs' });
  });

  it('throws the edit away on Escape', () => {
    const input = startRename();
    type(input, 'Cliffs');
    key(input, 'Escape');
    expect(api.rename).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Rocks');
  });

  it('does not save a blank or unchanged name', () => {
    let input = startRename();
    type(input, '   ');
    key(input, 'Enter');
    input = startRename();
    key(input, 'Enter');
    expect(api.rename).not.toHaveBeenCalled();
  });
});
