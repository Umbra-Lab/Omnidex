import { ipcMain } from 'electron';
import { cacheStats, evictExpired } from '../orbital/cache';
import { matchAssetName } from '../orbital/matcher';
import type { OrbitalSearchRequest } from '../orbital/models';
import { getProduct } from '../orbital/product';
import { searchProducts } from '../orbital/search';

let registered = false;

interface GetProductArgs {
  slug: string;
  bypassCache?: boolean;
}

export function registerOrbitalIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('omnidex:orbital:search', (_event, req: OrbitalSearchRequest) =>
    searchProducts(req),
  );

  ipcMain.handle('omnidex:orbital:get-product', (_event, args: GetProductArgs) =>
    getProduct(args.slug, { bypassCache: args.bypassCache }),
  );

  ipcMain.handle('omnidex:orbital:cache-stats', () => cacheStats());

  ipcMain.handle('omnidex:orbital:evict-expired', () => evictExpired());

  ipcMain.handle('omnidex:orbital:match', (_event, args: { folderName: string; limit?: number }) =>
    matchAssetName(args.folderName, args.limit),
  );
}
