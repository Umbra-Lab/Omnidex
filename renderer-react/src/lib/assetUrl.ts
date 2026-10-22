/**
 * Turn a raw filesystem path into the `omnidex-asset://` URL the Electron
 * main-process protocol handler streams back. Safe for `<img src>` and
 * `<audio src>`. Returns `null` for empty input.
 */
export function toAssetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const bridge = (globalThis as { omnidex?: { fileUrl?: (p: string) => string } }).omnidex;
  if (bridge?.fileUrl) return bridge.fileUrl(path);
  // Browser-only preview fallback.
  return path;
}

/**
 * Resolve the best thumbnail URL for an asset: local cached thumbnail first,
 * then Orbital Market's CDN, otherwise null.
 */
export function resolveThumbnail(asset: {
  thumbnail_path: string | null;
  orbital_thumbnail_url: string | null;
}): string | null {
  if (asset.thumbnail_path) return toAssetUrl(asset.thumbnail_path);
  if (asset.orbital_thumbnail_url) return asset.orbital_thumbnail_url;
  return null;
}
