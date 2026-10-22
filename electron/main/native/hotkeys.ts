import { app, type BrowserWindow, globalShortcut } from 'electron';

/**
 * Register OS-level global hotkeys. Cmd+Shift+O focuses the main window and
 * signals the renderer to open the command palette. This keeps Omnidex's
 * quick-add accessible from anywhere in the OS.
 */
export function registerGlobalHotkeys(getMainWindow: () => BrowserWindow | null): void {
  app.whenReady().then(() => {
    globalShortcut.register('CommandOrControl+Shift+O', () => {
      const win = getMainWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('omnidex:palette:open');
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
