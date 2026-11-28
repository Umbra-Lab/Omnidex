import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  asset: {} as Record<string, unknown>,
  error: vi.fn(),
}));

vi.mock('@/ipc/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    assets: {
      get: { useQuery: () => ({ data: api.asset }) },
      setFavorite: { useMutation: () => ({ isPending: false }) },
    },
    scanLocations: { list: { useQuery: () => ({ data: [] }) } },
    scanner: { refreshOne: { useMutation: () => ({ isPending: false }) } },
    notes: {
      get: { useQuery: () => ({ data: null, isFetched: true }) },
      upsert: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));
vi.mock('../MatchPickerModal', () => ({ MatchPickerModal: () => null }));
vi.mock('@/components/ui/toaster', () => ({ toast: { error: api.error } }));

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useModals } from '@/stores/modals';
import { InspectorPanel } from '../InspectorPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function renderAsset(changes: Record<string, unknown> = {}, onClose: () => void = () => {}) {
  api.asset = { ...api.asset, ...changes };
  await act(async () =>
    root.render(<InspectorPanel assetId={Number(api.asset.id)} onClose={onClose} />),
  );
}

function button(name: string) {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

describe('asset inspection with incomplete information', () => {
  beforeEach(() => {
    api.asset = {
      id: 1,
      name: 'Local_Pack_UE5',
      orbital_title: null,
      file_path: 'E:\\Library\\Local_Pack_UE5',
      file_size: 1024,
      thumbnail_path: null,
      orbital_thumbnail_url: null,
      orbital_gallery_images: null,
      missing_since: null,
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    useModals.getState().closeAddToCollection();
    useModals.getState().closeTagging();
  });

  it('names the missing preview instead of leaving an unexplained image well', async () => {
    await renderAsset();
    expect(container.textContent).toContain('No preview available');
    expect(container.textContent).toContain('Not matched to a marketplace listing');
    expect(container.textContent).toContain('Not recorded');
  });

  it('keeps the indexed identity visible when the marketplace title differs', async () => {
    await renderAsset({ orbital_title: 'Marketplace Pack' });
    expect(container.querySelector('h2')?.textContent).toBe('Marketplace Pack');
    expect(container.textContent).toContain('Indexed as Local_Pack_UE5');
  });

  it.each([null, '', '   '])(
    'explains local path %s while keeping organization available',
    async (filePath) => {
      await renderAsset({ file_path: filePath, fab_owned: true });
      expect(button('Open folder').disabled).toBe(true);
      expect(container.textContent).toContain('No local path recorded');
      await act(async () => button('Add to collection').click());
      expect(useModals.getState().addToCollection?.assetIds).toEqual([1]);
      await act(async () => button('Manage tags').click());
      expect(useModals.getState().tagging?.assetId).toBe(1);
    },
  );

  it('does not offer a curated missing pack as an openable local asset', async () => {
    await renderAsset({ missing_since: '2026-10-31' });
    expect(button('Open folder').disabled).toBe(true);
    expect(container.textContent).toContain('Missing since');
  });

  it('reports a shell failure instead of silently ignoring the result', async () => {
    const openFileLocation = vi.fn(async () => ({ ok: false, error: 'not found' }));
    vi.stubGlobal('omnidex', { shell: { openFileLocation } });
    await renderAsset();
    expect(button('Open folder').disabled).toBe(false);
    await act(async () => button('Open folder').click());
    expect(openFileLocation).toHaveBeenCalledWith('E:\\Library\\Local_Pack_UE5');
    expect(container.textContent).toContain('Folder unavailable');
  });

  it('keeps the recorded source usable when the local copy is missing', async () => {
    const openExternal = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('omnidex', { shell: { openExternal } });
    await renderAsset({
      missing_since: '2026-10-31',
      orbital_source_url: 'https://orbital-market.com/product/pack',
    });
    expect(button('Open folder').disabled).toBe(true);
    await act(async () => button('View listing').click());
    expect(openExternal).toHaveBeenCalledWith('https://orbital-market.com/product/pack');
    expect(api.error).not.toHaveBeenCalled();
  });

  it('handles a rejected shell invocation', async () => {
    vi.stubGlobal('omnidex', {
      shell: { openFileLocation: vi.fn().mockRejectedValue(new Error('offline')) },
    });
    await renderAsset();
    await act(async () => button('Open folder').click());
    expect(api.error).toHaveBeenCalledWith("Couldn't open the asset folder. Please try again.");
  });

  describe('Escape', () => {
    function pressEscape(target: EventTarget = document.body) {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event;
    }

    it('closes the panel when nothing is open above it', async () => {
      const onClose = vi.fn();
      await renderAsset({}, onClose);
      const event = pressEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it.each(['alertdialog', 'dialog', 'menu', 'listbox'])(
      'leaves Escape to an open %s above the panel',
      async (role) => {
        const onClose = vi.fn();
        await renderAsset({}, onClose);
        // Radix content as it renders while open, focus on its Cancel button.
        const layer = document.createElement('div');
        layer.setAttribute('role', role);
        layer.setAttribute('data-state', 'open');
        const cancel = document.createElement('button');
        layer.append(cancel);
        document.body.append(layer);
        const seen = vi.fn();
        document.addEventListener('keydown', seen, { capture: true });
        try {
          const event = pressEscape(cancel);
          expect(onClose).not.toHaveBeenCalled();
          expect(event.defaultPrevented).toBe(false);
          // The key still reaches the layer's own document-level handler.
          expect(seen).toHaveBeenCalledTimes(1);
        } finally {
          document.removeEventListener('keydown', seen, { capture: true });
          layer.remove();
        }
      },
    );

    it('closes a real confirm dialog above the panel, and leaves the panel open', async () => {
      const onClose = vi.fn();
      const onOpenChange = vi.fn();
      api.asset = { ...api.asset };
      await act(async () =>
        root.render(
          <>
            <InspectorPanel assetId={Number(api.asset.id)} onClose={onClose} />
            <AlertDialog open onOpenChange={onOpenChange}>
              <AlertDialogContent>
                <AlertDialogTitle>Remove from library?</AlertDialogTitle>
                <AlertDialogDescription>Gone on the next scan.</AlertDialogDescription>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
              </AlertDialogContent>
            </AlertDialog>
          </>,
        ),
      );
      const cancel = [...document.querySelectorAll('button')].find(
        (b) => b.textContent === 'Cancel',
      );
      expect(cancel).toBeDefined();
      await act(async () => {
        pressEscape(cancel);
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes the panel again once the layer has closed', async () => {
      const onClose = vi.fn();
      await renderAsset({}, onClose);
      const layer = document.createElement('div');
      layer.setAttribute('role', 'alertdialog');
      layer.setAttribute('data-state', 'closed');
      document.body.append(layer);
      try {
        pressEscape();
        expect(onClose).toHaveBeenCalledTimes(1);
      } finally {
        layer.remove();
      }
    });
  });

  describe('gallery arrow keys', () => {
    const gallery = JSON.stringify(['one.png', 'two.png']);
    const shown = () => container.querySelector('img')?.getAttribute('src');
    const press = (key: string) =>
      act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });

    it('step through the images', async () => {
      await renderAsset({ orbital_gallery_images: gallery });
      expect(shown()).toBe('one.png');
      await press('ArrowRight');
      expect(shown()).toBe('two.png');
    });

    it('leave an open menu above the panel alone', async () => {
      await renderAsset({ orbital_gallery_images: gallery });
      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-state', 'open');
      document.body.append(menu);
      try {
        await press('ArrowRight');
        expect(shown()).toBe('one.png');
      } finally {
        menu.remove();
      }
    });
  });

  it('labels a failed preview and recovers when another asset is selected', async () => {
    await renderAsset({ thumbnail_path: 'broken.png' });
    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.textContent).toContain('Preview unavailable');
    await renderAsset({ id: 2, thumbnail_path: 'working.png' });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('working.png');
    expect(container.textContent).not.toContain('Preview unavailable');
  });
});
