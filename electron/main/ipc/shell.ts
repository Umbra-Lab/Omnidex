import { app, ipcMain, shell } from 'electron';
import { openDatabase } from '../db/connection';
import { scanLocationsRepo } from '../db/repos';
import { planOpenLocation, planOpenPath, type ShellPlan } from './path-guard';

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

/** Carry out an open or reveal decided by path-guard, on the canonical path. */
async function runPlan(
  plan: Exclude<ShellPlan, { kind: 'refuse' }>,
): Promise<{ ok: boolean; error?: string; openedParent?: true }> {
  if (plan.kind === 'reveal') {
    shell.showItemInFolder(plan.path);
    return { ok: true };
  }
  const err = await shell.openPath(plan.path);
  if (err) return { ok: false, error: err };
  return plan.openedParent ? { ok: true, openedParent: true } : { ok: true };
}

let registered = false;

export function registerShellIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('omnidex:shell:open-path', async (_e, path: string) => {
    if (!path) return { ok: false, error: 'empty path' };
    // Only media, plain documents and folders: opening anything else with its
    // default app can run it. See planOpenPath.
    const plan = planOpenPath(path, assetRoots());
    if (plan.kind === 'refuse') {
      console.warn(`[omnidex] shell:open-path refused (${plan.error}): ${path}`);
      return { ok: false, error: plan.error };
    }
    return runPlan(plan);
  });

  ipcMain.handle('omnidex:shell:open-file-location', async (_e, path: string) => {
    if (!path) return { ok: false, error: 'empty path' };
    const plan = planOpenLocation(path, assetRoots());
    if (plan.kind === 'refuse') {
      if (plan.error === 'path not allowed') {
        console.warn(
          `[omnidex] shell:open-file-location denied path outside allowed roots: ${path}`,
        );
      }
      return { ok: false, error: plan.error };
    }
    return runPlan(plan);
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
