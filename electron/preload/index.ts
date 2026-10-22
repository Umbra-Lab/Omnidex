import { contextBridge, ipcRenderer } from 'electron';
import { exposeElectronTRPC } from 'electron-trpc/preload';

// electron-trpc exposes a typed channel the React renderer consumes via
// `ipcLink()`. Must be called before contextBridge.exposeInMainWorld.
exposeElectronTRPC();

const scannerBridge = {
  start: (locationId: number): Promise<unknown> =>
    ipcRenderer.invoke('omnidex:scanner:start', locationId),

  cancel: (locationId: number): Promise<boolean> =>
    ipcRenderer.invoke('omnidex:scanner:cancel', locationId),

  activeCount: (): Promise<number> => ipcRenderer.invoke('omnidex:scanner:active-count'),
};

const uassetBridge = {
  extractThumbnail: (uassetPath: string, targetSize?: number): Promise<string | null> =>
    ipcRenderer.invoke('omnidex:uasset:extract-thumbnail', { uassetPath, targetSize }),

  parseHeader: (
    uassetPath: string,
  ): Promise<{ magic: string; packageFileVersion: number; hasThumbnail: boolean }> =>
    ipcRenderer.invoke('omnidex:uasset:parse-header', uassetPath),
};

interface OrbitalSearchRequest {
  searchText: string;
  limit?: number;
  skip?: number;
  sortField?: 'popularity' | 'release' | 'updated' | 'name' | 'price' | 'rating';
  sortDirection?: 'asc' | 'desc';
}

const orbitalBridge = {
  search: (req: OrbitalSearchRequest): Promise<unknown[]> =>
    ipcRenderer.invoke('omnidex:orbital:search', req),

  getProduct: (slug: string, bypassCache?: boolean): Promise<unknown | null> =>
    ipcRenderer.invoke('omnidex:orbital:get-product', { slug, bypassCache }),

  cacheStats: (): Promise<{
    total: number;
    expired: number;
    avgResponseMs: number | null;
  }> => ipcRenderer.invoke('omnidex:orbital:cache-stats'),

  evictExpired: (): Promise<number> => ipcRenderer.invoke('omnidex:orbital:evict-expired'),

  match: (folderName: string, limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke('omnidex:orbital:match', { folderName, limit }),
};

const fabBridge = {
  startWatch: (rootPath?: string): Promise<{ watching: string }> =>
    ipcRenderer.invoke('omnidex:fab:start-watch', rootPath),

  stopWatch: (): Promise<boolean> => ipcRenderer.invoke('omnidex:fab:stop-watch'),

  isWatching: (): Promise<{ watching: boolean; root: string | null }> =>
    ipcRenderer.invoke('omnidex:fab:is-watching'),

  defaultVaultPath: (): Promise<string> => ipcRenderer.invoke('omnidex:fab:default-vault-path'),
};

const events = {
  /**
   * Subscribe to a channel emitted by the main process via
   * `webContents.send(channel, payload)`. Returns an unlisten function
   * with the same shape as Tauri's `listen()` so `bridge.on()` can route
   * to it transparently.
   */
  on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

const shellBridge = {
  openPath: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('omnidex:shell:open-path', path),
  openFileLocation: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('omnidex:shell:open-file-location', path),
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('omnidex:shell:open-external', url),
};

interface OpenFolderArgs {
  title?: string;
  defaultPath?: string;
  multi?: boolean;
}

interface OpenFileArgs extends OpenFolderArgs {
  filters?: { name: string; extensions: string[] }[];
}

const dialogBridge = {
  openFolder: (args?: OpenFolderArgs): Promise<string | string[] | null> =>
    ipcRenderer.invoke('omnidex:dialog:open-folder', args ?? {}),
  openFile: (args?: OpenFileArgs): Promise<string | string[] | null> =>
    ipcRenderer.invoke('omnidex:dialog:open-file', args ?? {}),
  save: (args?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null> => ipcRenderer.invoke('omnidex:dialog:save', args ?? {}),
  writeText: (path: string, contents: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('omnidex:fs:write-text', { path, contents }),
};

const credsBridge = {
  save: (kind: string, key: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke('omnidex:creds:save', { kind, key, value }),
  load: (kind: string, key: string): Promise<string> =>
    ipcRenderer.invoke('omnidex:creds:load', { kind, key }),
  delete: (kind: string, key: string): Promise<boolean> =>
    ipcRenderer.invoke('omnidex:creds:delete', { kind, key }),
};

/**
 * Converts an absolute file path to an `omnidex-asset://` URL the renderer
 * can put in `<img src>` or `<audio src>`. Forward-slashes and URI-encodes
 * each segment so Windows drive letters work.
 */
function fileUrl(absolutePath: string): string {
  if (!absolutePath) return '';
  if (absolutePath.startsWith('omnidex-asset://') || absolutePath.startsWith('http')) {
    return absolutePath;
  }
  const normalized = absolutePath.replace(/\\/g, '/');
  return `omnidex-asset:///${encodeURI(normalized)}`;
}

interface SerializedMenuItem {
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'submenu';
  accelerator?: string;
  enabled?: boolean;
  submenu?: SerializedMenuItem[];
}

const menuBridge = {
  popup: (args: { items: SerializedMenuItem[]; x?: number; y?: number }): Promise<string | null> =>
    ipcRenderer.invoke('omnidex:menu:popup', args),
};

const notifyBridge = {
  show: (args: { title: string; body?: string; silent?: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('omnidex:notify', args),
};

const omnidex = {
  runtime: 'electron' as const,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  scanner: scannerBridge,
  uasset: uassetBridge,
  orbital: orbitalBridge,
  fab: fabBridge,
  shell: shellBridge,
  dialog: dialogBridge,
  creds: credsBridge,
  menu: menuBridge,
  notify: notifyBridge,
  fileUrl,
  events,
};

contextBridge.exposeInMainWorld('omnidex', omnidex);

export type OmnidexBridge = typeof omnidex;
