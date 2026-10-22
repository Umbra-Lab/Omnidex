import { ipcMain } from 'electron';
import { defaultVaultPath, isWatching, start, stop } from '../fab/watcher';

let registered = false;

export function registerFabIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('omnidex:fab:start-watch', (_event, rootPath?: string) => start(rootPath));

  ipcMain.handle('omnidex:fab:stop-watch', async () => {
    await stop();
    return true;
  });

  ipcMain.handle('omnidex:fab:is-watching', () => isWatching());

  ipcMain.handle('omnidex:fab:default-vault-path', () => defaultVaultPath());
}
