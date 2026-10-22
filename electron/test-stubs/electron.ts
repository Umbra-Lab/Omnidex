// Test-only stub for the `electron` module.
//
// Aliased to `electron` in vitest.config.ts so unit tests never need the real
// Electron binary. CI installs with `--ignore-scripts` (cheap runner, no native
// builds — see .github/workflows/ci.yml), so `node_modules/electron` has no
// downloaded binary and `require('electron')` throws "Electron failed to install
// correctly". Several pure-logic modules transitively import `electron` only for
// `app.getPath(...)` (e.g. db/paths.ts, logger.ts), which would otherwise drag
// the whole binary into the unit suite. This stub satisfies those imports with
// inert, deterministic values.
//
// The REAL app build (electron-vite) is unaffected — this alias lives in the
// vitest config only.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = (): void => {};
const testPath = (name: string): string => join(tmpdir(), `omnidex-test-${name}`);
const FULL_DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

export const app = {
  getPath: testPath,
  getName: () => 'omnidex',
  setName: noop,
  getVersion: () => '0.0.0-test',
  getAppPath: () => process.cwd(),
  whenReady: () => Promise.resolve(),
  on: noop,
  once: noop,
  quit: noop,
  exit: noop,
  isPackaged: false,
  setAppUserModelId: noop,
  requestSingleInstanceLock: () => true,
};

export class BrowserWindow {
  webContents = {
    send: noop,
    on: noop,
    session: { webRequest: { onHeadersReceived: noop } },
    isDestroyed: () => false,
  };
  on = noop;
  once = noop;
  loadURL = noop;
  loadFile = noop;
  show = noop;
  static getAllWindows = () => [] as BrowserWindow[];
  static fromWebContents = () => null;
}

export const ipcMain = { handle: noop, on: noop, removeHandler: noop };
export const ipcRenderer = { invoke: () => Promise.resolve(), on: noop, send: noop };
export const dialog = {
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showErrorBox: noop,
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
};
export const shell = {
  openPath: () => Promise.resolve(''),
  openExternal: () => Promise.resolve(),
  showItemInFolder: noop,
};
export const Menu = { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop };
export const crashReporter = { start: noop };
export const session = { defaultSession: { webRequest: { onHeadersReceived: noop } } };
export const screen = {
  getAllDisplays: () => [FULL_DISPLAY],
  getPrimaryDisplay: () => FULL_DISPLAY,
};
export const protocol = { handle: noop, registerSchemesAsPrivileged: noop };
export const nativeImage = { createFromPath: () => ({}) };

export default {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  dialog,
  shell,
  Menu,
  crashReporter,
  session,
  screen,
  protocol,
  nativeImage,
};
