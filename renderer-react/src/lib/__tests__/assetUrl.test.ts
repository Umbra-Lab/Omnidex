import { afterEach, describe, expect, it } from 'vitest';
import { resolveThumbnail, toAssetUrl } from '../assetUrl';

type OmnidexBridge = { fileUrl?: (p: string) => string };

function setBridge(bridge: OmnidexBridge | undefined): void {
  (globalThis as { omnidex?: OmnidexBridge }).omnidex = bridge;
}

afterEach(() => {
  setBridge(undefined);
});

describe('toAssetUrl', () => {
  it('returns null for empty, null, or undefined paths', () => {
    expect(toAssetUrl(null)).toBeNull();
    expect(toAssetUrl(undefined)).toBeNull();
    expect(toAssetUrl('')).toBeNull();
  });

  it('routes through the omnidex bridge when it exposes fileUrl', () => {
    setBridge({ fileUrl: (p) => `omnidex-asset://${encodeURIComponent(p)}` });
    expect(toAssetUrl('C:/packs/thumb.png')).toBe('omnidex-asset://C%3A%2Fpacks%2Fthumb.png');
  });

  it('falls back to the raw path when no bridge is present (browser preview)', () => {
    setBridge(undefined);
    expect(toAssetUrl('C:/packs/thumb.png')).toBe('C:/packs/thumb.png');
  });

  it('falls back to the raw path when the bridge lacks fileUrl', () => {
    setBridge({});
    expect(toAssetUrl('/tmp/x.jpg')).toBe('/tmp/x.jpg');
  });
});

describe('resolveThumbnail', () => {
  it('prefers a local thumbnail (via the bridge) over the orbital CDN url', () => {
    setBridge({ fileUrl: (p) => `local://${p}` });
    expect(
      resolveThumbnail({
        thumbnail_path: '/cache/a.png',
        orbital_thumbnail_url: 'https://cdn.orbital/x.jpg',
      }),
    ).toBe('local:///cache/a.png');
  });

  it('falls back to the orbital CDN url when there is no local thumbnail', () => {
    expect(
      resolveThumbnail({
        thumbnail_path: null,
        orbital_thumbnail_url: 'https://cdn.orbital/x.jpg',
      }),
    ).toBe('https://cdn.orbital/x.jpg');
  });

  it('returns null when neither source is available', () => {
    expect(resolveThumbnail({ thumbnail_path: null, orbital_thumbnail_url: null })).toBeNull();
  });
});
