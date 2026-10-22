import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from 'electron';
import { checkForUpdates } from './updater';

/**
 * Native application menu (the macOS menu bar / Windows menu).
 *
 * Without an explicit menu, Electron installs a bare default and several
 * standard shortcuts (Cmd/Ctrl+C/V/A, undo/redo, minimize, fullscreen, zoom)
 * either don't work or aren't discoverable. This builds a proper role-based
 * template so the OS wires up those accelerators natively — no per-key
 * `globalShortcut` plumbing, and the items grey out correctly when no editable
 * field is focused.
 *
 * 'Check for Updates…' opens Settings → About and runs one manual check, so the
 * result shows in the status line there. It is greyed out in development
 * builds, where update checks never run (see updater.ts).
 *
 * `View → Reload / Toggle DevTools` are dev-only (gated on `!app.isPackaged`) so
 * a shipped build can't be reloaded out of its file:// bundle or pop devtools.
 */

const isMac = process.platform === 'darwin';

export function buildAppMenu(getMainWindow: () => BrowserWindow | null): Menu {
  const appName = app.getName();

  const checkForUpdatesItem: MenuItemConstructorOptions = {
    id: 'check-for-updates',
    label: 'Check for Updates…',
    enabled: app.isPackaged,
    click: () => {
      const win = getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send('omnidex:settings:open', 'about');
      }
      void checkForUpdates('manual');
    },
  };

  // macOS gets a dedicated app menu (the bold first item); other platforms fold
  // About/Quit into File. The 'role: appMenu' macro would also work, but we want
  // the "Check for Updates…" entry beside About, so we spell it out.
  const appMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: 'about', label: `About ${appName}` },
      checkForUpdatesItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: `Hide ${appName}` },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: `Quit ${appName}` },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'delete' },
            { type: 'separator' },
            { role: 'selectAll' },
          ] as MenuItemConstructorOptions[])),
    ],
  };

  // Reload + DevTools only in dev (see module doc). resetZoom/zoomIn/zoomOut and
  // fullscreen are always available.
  const viewSubmenu: MenuItemConstructorOptions[] = [];
  if (!app.isPackaged) {
    viewSubmenu.push(
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
    );
  }
  viewSubmenu.push(
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  );
  const viewMenu: MenuItemConstructorOptions = { label: 'View', submenu: viewSubmenu };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? ([
            { type: 'separator' },
            { role: 'front' },
            { type: 'separator' },
            { role: 'window' },
          ] as MenuItemConstructorOptions[])
        : ([{ role: 'close' }] as MenuItemConstructorOptions[])),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'Learn More',
        click: () => {
          void shell.openExternal('https://github.com/');
        },
      },
      {
        label: 'View License',
        click: () => {
          void shell.openExternal('https://opensource.org/license/mit');
        },
      },
    ],
  };

  // On non-mac, prepend a File menu carrying Quit (mac keeps Quit in the app
  // menu). Edit/View/Window/Help are shared.
  const template: MenuItemConstructorOptions[] = isMac
    ? [appMenu, editMenu, viewMenu, windowMenu, helpMenu]
    : [
        {
          label: 'File',
          submenu: [
            { role: 'about', label: `About ${appName}` },
            checkForUpdatesItem,
            { type: 'separator' },
            { role: 'quit', label: `Quit ${appName}` },
          ],
        },
        editMenu,
        viewMenu,
        windowMenu,
        helpMenu,
      ];

  return Menu.buildFromTemplate(template);
}

/** Build and install the application menu. Call once at app-ready. */
export function installAppMenu(getMainWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(buildAppMenu(getMainWindow));
}
