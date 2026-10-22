import { extractThumbnail, parseUasset } from '@omnidex/uasset';
import { ipcMain } from 'electron';
import { thumbnailsDir } from '../db/paths';

let registered = false;

/**
 * IPC handlers for the native uasset addon. Lets the renderer trigger
 * on-demand thumbnail extraction for a single asset (e.g. a
 * "Regenerate thumbnail" context menu action) without requiring a full
 * scan pass.
 */
export function registerUassetIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'omnidex:uasset:extract-thumbnail',
    async (_event, args: { uassetPath: string; targetSize?: number }) => {
      const targetSize = args.targetSize ?? 256;
      const pngPath: string | null = await extractThumbnail(
        args.uassetPath,
        thumbnailsDir(),
        targetSize,
      );
      return pngPath;
    },
  );

  ipcMain.handle('omnidex:uasset:parse-header', (_event, uassetPath: string) =>
    parseUasset(uassetPath),
  );
}
