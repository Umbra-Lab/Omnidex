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
    notes: {
      get: { useQuery: () => ({ data: null, isFetched: true }) },
      upsert: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));
vi.mock('../MatchPickerModal', () => ({ MatchPickerModal: () => null }));
vi.mock('@/components/ui/toaster', () => ({ toast: { error: api.error } }));

import { useModals } from '@/stores/modals';
import { InspectorPanel } from '../InspectorPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function renderAsset(changes: Record<string, unknown> = {}) {
  api.asset = { ...api.asset, ...changes };
  await act(async () =>
    root.render(<InspectorPanel assetId={Number(api.asset.id)} onClose={() => {}} />),
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

  it.each([
    null,
    '',
    '   ',
  ])('explains local path %s while keeping organization available', async (filePath) => {
    await renderAsset({ file_path: filePath, fab_owned: true });
    expect(button('Open folder').disabled).toBe(true);
    expect(container.textContent).toContain('No local path recorded');
    await act(async () => button('Add to collection').click());
    expect(useModals.getState().addToCollection?.assetIds).toEqual([1]);
    await act(async () => button('Manage tags').click());
    expect(useModals.getState().tagging?.assetId).toBe(1);
  });

  it('does not offer a curated missing pack as an openable local asset', async () => {
    await renderAsset({ missing_since: '2026-10-31' });
    expect(button('Open folder').disabled).toBe(true);
    expect(container.textContent).toContain('Not found in the last scan');
  });

  it('reports a shell failure instead of silently ignoring the result', async () => {
    const openFileLocation = vi.fn(async () => ({ ok: false, error: 'not found' }));
    vi.stubGlobal('omnidex', { shell: { openFileLocation } });
    await renderAsset();
    expect(button('Open folder').disabled).toBe(false);
    await act(async () => button('Open folder').click());
    expect(openFileLocation).toHaveBeenCalledWith('E:\\Library\\Local_Pack_UE5');
    expect(api.error).toHaveBeenCalled();
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

  it('labels a failed preview and recovers when another asset is selected', async () => {
    await renderAsset({ thumbnail_path: 'broken.png' });
    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.textContent).toContain('Preview unavailable');
    await renderAsset({ id: 2, thumbnail_path: 'working.png' });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('working.png');
    expect(container.textContent).not.toContain('Preview unavailable');
  });
});
