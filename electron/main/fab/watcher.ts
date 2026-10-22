import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';

/**
 * Epic FAB VaultCache watcher.
 *
 * Port of `src-tauri/src/fab/watcher.rs` — minus the auth/sync pieces that
 * the user hasn't asked for yet. Watches the VaultCache directory for new
 * `.manifest` files (Epic drops one per downloaded asset) and emits
 * `fab-asset-discovered` IPC events so the renderer can refresh its
 * library view.
 */

export interface ManifestSnippet {
  name?: string;
  build?: string;
  installSize?: number;
}

/** Result of {@link start}: either the active root, or a typed failure. */
export type StartResult = { watching: string } | { error: 'not-found'; root: string };

let watcher: FSWatcher | null = null;
let watchedRoot: string | null = null;

function emit(payload: {
  name: string;
  manifestPath: string;
  installSize?: number;
  build?: string;
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('fab-asset-discovered', payload);
  }
}

export async function parseManifest(path: string): Promise<ManifestSnippet> {
  try {
    const raw = await readFile(path, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      build: typeof data.build === 'string' ? data.build : undefined,
      installSize: typeof data.installSize === 'number' ? data.installSize : undefined,
    };
  } catch {
    return {};
  }
}

export function defaultVaultPath(): string {
  // Epic Games Launcher's default VaultCache location, per platform — Windows
  // path documented in `src-tauri/src/fab/vault_detector.rs`. A user-configured
  // path overrides this via `start()` below.
  if (process.platform === 'win32') {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      'EpicGamesLauncher',
      'VaultCache',
    );
  }
  if (process.platform === 'darwin') {
    // The macOS launcher keeps its data under Application Support; the Vault
    // download cache mirrors the Windows layout one level down.
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Epic',
      'EpicGamesLauncher',
      'VaultCache',
    );
  }
  return join(homedir(), 'Epic', 'VaultCache');
}

/**
 * `true` for paths the watcher should ignore. chokidar v5 removed glob
 * support, so the old `chokidar.watch('**\/*.manifest', …)` pattern was
 * treated as a *literal* directory name that never exists — `'add'` never
 * fired and FAB new-asset detection was dead on every OS. We instead watch
 * the vault root directly (bounded by `depth`) and filter here: keep
 * directories so chokidar recurses into them, and among files keep only
 * `*.manifest`.
 */
function ignoreNonManifest(path: string, stats?: { isDirectory(): boolean }): boolean {
  // chokidar invokes the predicate twice: once with just the path (no stats,
  // pre-stat) and once with stats. Without stats we cannot tell a dir from a
  // file, so never prune — let the stats-bearing call decide.
  if (!stats) return false;
  if (stats.isDirectory()) return false;
  return !path.endsWith('.manifest');
}

export function start(rootPath?: string): StartResult {
  const root = rootPath ?? defaultVaultPath();
  if (watcher && watchedRoot === root) {
    return { watching: root };
  }

  // A missing root used to be reported as a successful watch: chokidar would
  // sit on a non-existent path and silently never fire. Surface it instead so
  // callers can prompt the user to pick a real VaultCache.
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { error: 'not-found', root };
  }

  if (watcher) {
    watcher.close().catch(() => {});
    watcher = null;
    watchedRoot = null;
  }

  watcher = chokidar.watch(root, {
    ignoreInitial: false,
    ignored: ignoreNonManifest,
    awaitWriteFinish: {
      stabilityThreshold: 1500,
      pollInterval: 100,
    },
    usePolling: false,
    depth: 4,
  });

  watcher.on('add', async (fullPath: string) => {
    if (!fullPath.endsWith('.manifest')) return;
    const snippet = await parseManifest(fullPath);
    emit({
      name: snippet.name ?? basename(fullPath).replace(/\.manifest$/, ''),
      manifestPath: fullPath,
      build: snippet.build,
      installSize: snippet.installSize,
    });
  });

  watcher.on('error', (err) => {
    console.warn(`[fab-watcher] ${(err as Error).message}`);
  });

  watchedRoot = root;
  return { watching: root };
}

export async function stop(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
    watchedRoot = null;
  }
}

export function isWatching(): { watching: boolean; root: string | null } {
  return { watching: watcher !== null, root: watchedRoot };
}
