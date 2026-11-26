import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  readonly id: number;
  readonly name: string;
  readonly is_favorite: boolean;
}

const api = vi.hoisted(() => ({
  q: '' as string,
  rows: [] as Array<{ id: number; name: string; is_favorite: boolean }>,
  favoriteMutate: vi.fn(),
  invalidated: [] as string[],
  favoriteOptions: null as null | {
    onSettled?: () => void;
  },
}));

function listRows(input: { filter: { is_favorite: boolean | null } }): Row[] {
  return input.filter.is_favorite ? api.rows.filter((r) => r.is_favorite) : api.rows;
}

vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({ q: api.q }) }));
vi.mock('@trpc/react-query', () => ({
  getQueryKey: (proc: { __name: string }, input: unknown, type: string) => [
    proc.__name,
    input,
    type,
  ],
}));
vi.mock('@/ipc/trpc', () => {
  const inv = (name: string) => ({ invalidate: () => api.invalidated.push(name) });
  return {
    trpc: {
      useUtils: () => ({
        client: {
          assets: {
            listCards: { query: async (input: never) => listRows(input) },
            search: { query: async (input: never) => listRows(input) },
          },
        },
        assets: {
          ...inv('assets'),
          favoriteCount: inv('assets.favoriteCount'),
          get: inv('assets.get'),
          count: inv('assets.count'),
        },
      }),
      assets: {
        listCards: { __name: 'listCards' },
        search: { __name: 'search' },
        count: { useQuery: () => ({ data: api.rows.length }) },
        searchCount: { useQuery: () => ({ data: undefined }) },
        stats: { useQuery: () => ({ data: { with_orbital: 0 } }) },
        setFavorite: {
          useMutation: (opts: { onSettled?: () => void }) => {
            api.favoriteOptions = opts;
            return { isPending: false, mutate: api.favoriteMutate };
          },
        },
        delete: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
      },
      scanLocations: { list: { useQuery: () => ({ data: [] }) } },
    },
  };
});

// Children reduced to the props this test reads, so the view's own wiring is
// what is under test.
vi.mock('@/features/assets/SourceList', () => ({
  SourceList: ({ onSelect }: { onSelect: (k: string) => void }) => (
    <button type="button" data-testid="facet-favorites" onClick={() => onSelect('favorites')}>
      Favorites
    </button>
  ),
}));
vi.mock('@/features/assets/AssetToolbar', () => ({
  AssetToolbar: ({ onSortChange }: { onSortChange: (s: string) => void }) => (
    <button type="button" data-testid="sort-name" onClick={() => onSortChange('name_asc')}>
      Sort
    </button>
  ),
}));
vi.mock('@/features/assets/AssetGrid', () => ({
  AssetGrid: ({
    assets,
    onToggleFavorite,
  }: {
    assets: Row[];
    onToggleFavorite: (id: number, next: boolean) => void;
  }) => (
    <ul data-testid="grid">
      {assets.map((a) => (
        <li key={a.id}>
          <button type="button" onClick={() => onToggleFavorite(a.id, !a.is_favorite)}>
            fav-{a.id}
          </button>
        </li>
      ))}
    </ul>
  ),
}));
vi.mock('@/features/assets/AssetTable', () => ({ AssetTable: () => null }));
vi.mock('@/features/assets/FilterChips', () => ({ FilterChips: () => null }));
vi.mock('@/features/assets/InspectorPanel', () => ({ InspectorPanel: () => null }));
vi.mock('@/features/assets/BulkActionBar', () => ({
  BulkActionBar: ({ count, onFavorite }: { count: number; onFavorite: () => void }) => (
    <div>
      <span data-testid="bulk-count">{count}</span>
      <button type="button" data-testid="bulk-favorite" onClick={onFavorite}>
        Favorite
      </button>
    </div>
  ),
}));
vi.mock('@/components/ui/toaster', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssetsView } from '../AssetsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AssetsView />
      </QueryClientProvider>,
    ),
  );
  await flush();
}

const byTestId = (id: string) => {
  const el = container.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el as HTMLElement;
};

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

async function selectAllFrom(target: EventTarget) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  });
}

describe('AssetsView selection and favourites', () => {
  beforeEach(() => {
    api.q = '';
    api.rows = [
      { id: 1, name: 'One', is_favorite: true },
      { id: 2, name: 'Two', is_favorite: false },
      { id: 3, name: 'Three', is_favorite: false },
    ];
    api.invalidated = [];
    api.favoriteMutate.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('leaves Ctrl/Cmd+A to a focused text field instead of selecting every asset', async () => {
    await render();
    const input = document.createElement('input');
    document.body.append(input);
    await selectAllFrom(input);
    expect(byTestId('bulk-count').textContent).toBe('0');
    input.remove();

    await selectAllFrom(document);
    expect(byTestId('bulk-count').textContent).toBe('3');
  });

  it('drops the selection when the facet changes, so bulk actions only touch visible rows', async () => {
    await render();
    await selectAllFrom(document);
    expect(byTestId('bulk-count').textContent).toBe('3');

    await click(byTestId('facet-favorites'));
    expect(byTestId('grid').textContent).toBe('fav-1');
    expect(byTestId('bulk-count').textContent).toBe('0');
  });

  it('drops the selection when the sort changes', async () => {
    await render();
    await selectAllFrom(document);
    await click(byTestId('sort-name'));
    expect(byTestId('bulk-count').textContent).toBe('0');
  });

  it('bulk favourite mutates exactly the rows whose state decided the direction', async () => {
    await render();
    await selectAllFrom(document);
    await click(byTestId('bulk-favorite'));
    expect(api.favoriteMutate).toHaveBeenCalledWith({ ids: [1, 2, 3], favorite: true });
  });

  it('refreshes the inspector and the count after a favourite settles', async () => {
    await render();
    await click(container.querySelector('li button') as HTMLElement);
    expect(api.favoriteMutate).toHaveBeenCalledWith({ ids: [1], favorite: false });
    act(() => api.favoriteOptions?.onSettled?.());
    expect(api.invalidated).toEqual(
      expect.arrayContaining(['assets.favoriteCount', 'assets.get', 'assets.count']),
    );
  });

  it('keeps the selection when the sort changes during a search, which ignores sort', async () => {
    api.q = 'o';
    await render();
    await selectAllFrom(document);
    await click(byTestId('sort-name'));
    expect(byTestId('bulk-count').textContent).toBe('3');
  });

  it('leaves the selection alone when Escape is meant for a dialog', async () => {
    await render();
    await selectAllFrom(document);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.append(button);
    document.body.append(dialog);
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(byTestId('bulk-count').textContent).toBe('3');

    const handled = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    await act(async () => {
      document.dispatchEvent(handled);
    });
    expect(byTestId('bulk-count').textContent).toBe('3');
    dialog.remove();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(byTestId('bulk-count').textContent).toBe('0');
  });
});
