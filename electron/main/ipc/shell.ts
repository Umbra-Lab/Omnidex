import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { app, ipcMain, shell } from 'electron';
import { openDatabase } from '../db/connection';
import { scanLocationsRepo } from '../db/repos';
import { resolveWithin } from './path-guard';

/**
 * Shell operations. Replaces `@tauri-apps/plugin-shell` open() + Tauri's
 * `open_file_location` command.
 */

/**
 * Active scan-location roots + userData — the only paths the renderer may ask
 * the OS to open or reveal. Without this, `shell.openPath`/`showItemInFolder`
 * on a renderer-controlled path is an arbitrary-launch primitive (a planted
 * `.app`/`.command`/`.exe`/`.lnk` opened with its default handler).
 */
function assetRoots(): string[] {
  const roots: string[] = [app.getPath('userData')];
  try {
    for (const loc of scanLocationsRepo.listScanLocations(openDatabase())) {
      if (loc.is_active && loc.path) roots.push(loc.path);
    }
  } catch {
    // DB unreadable -> userData-only containment.
  }
  return roots;
}

/**
 * Only web-safe schemes may be handed to the OS. `shell.openExternal` will
 * otherwise launch local programs / protocol handlers (file:, smb:, vscode:,
 * ssh:, …) — a credential-leak / arbitrary-launch vector reachable straight
 * from the renderer. Everything outside http/https/mailto is denied + logged.
 */
function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const { protocol: scheme } = new URL(rawUrl);
    return scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:';
  } catch {
    return false;
  }
}

let registered = false;

export function registerShellIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('omnidex:shell:open-path', async (_e, path: string) => {
    if (!path) return { ok: false, error: 'empty path' };
    let safePath: string;
    try {
      safePath = resolveWithin(path, assetRoots(), { allowMissing: true });
    } catch {
      console.warn(`[omnidex] shell:open-path denied path outside allowed roots: ${path}`);
      return { ok: false, error: 'path not allowed' };
    }
    if (!existsSync(safePath)) return { ok: false, error: 'not found' };
    const err = await shell.openPath(safePath);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('omnidex:shell:open-file-location', async (_e, path: string) => {
    if (!path) return { ok: false, error: 'empty path' };
    let safePath: string;
    try {
      safePath = resolveWithin(path, assetRoots(), { allowMissing: true });
    } catch {
      console.warn(`[omnidex] shell:open-file-location denied path outside allowed roots: ${path}`);
      return { ok: false, error: 'path not allowed' };
    }
    if (existsSync(safePath)) {
      const isDir = statSync(safePath).isDirectory();
      if (isDir) {
        const err = await shell.openPath(safePath);
        return err ? { ok: false, error: err } : { ok: true };
      }
      shell.showItemInFolder(safePath);
      return { ok: true };
    }
    const parent = dirname(safePath);
    if (existsSync(parent)) {
      const err = await shell.openPath(parent);
      return err ? { ok: false, error: err } : { ok: true };
    }
    return { ok: false, error: 'not found' };
  });

  ipcMain.handle('omnidex:shell:open-external', async (_e, url: string) => {
    if (!url) return { ok: false, error: 'empty url' };
    if (!isAllowedExternalUrl(url)) {
      console.warn(`[omnidex] shell:open-external denied disallowed scheme: ${url}`);
      return { ok: false, error: 'scheme not allowed' };
    }
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
