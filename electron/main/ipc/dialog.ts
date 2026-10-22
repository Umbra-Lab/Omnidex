import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { resolveWithin } from './path-guard';

/**
 * Native dialog IPC. Replaces `@tauri-apps/plugin-dialog` open().
 */

/**
 * Paths the user explicitly picked via `omnidex:dialog:save` in this session.
 * `omnidex:fs:write-text` only writes to a path that is either inside userData
 * or one of these dialog-blessed locations — the renderer can't talk the main
 * process into overwriting an arbitrary file it never showed the user a Save
 * dialog for. Resolved (absolute) form is stored so the membership test is
 * normalisation-proof.
 */
const dialogChosenSavePaths = new Set<string>();

const writeTextSchema = z.object({
  path: z.string().min(1),
  contents: z.string().optional(),
});

interface OpenFolderArgs {
  title?: string;
  defaultPath?: string;
  multi?: boolean;
}

interface OpenFileArgs extends OpenFolderArgs {
  filters?: { name: string; extensions: string[] }[];
}

let registered = false;

function getOwnerWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

export function registerDialogIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('omnidex:dialog:open-folder', async (_e, args: OpenFolderArgs = {}) => {
    const win = getOwnerWindow();
    const result = await (win
      ? dialog.showOpenDialog(win, {
          title: args.title ?? 'Select a folder',
          defaultPath: args.defaultPath,
          properties: args.multi ? ['openDirectory', 'multiSelections'] : ['openDirectory'],
        })
      : dialog.showOpenDialog({
          title: args.title ?? 'Select a folder',
          defaultPath: args.defaultPath,
          properties: args.multi ? ['openDirectory', 'multiSelections'] : ['openDirectory'],
        }));
    if (result.canceled || result.filePaths.length === 0) return null;
    return args.multi ? result.filePaths : result.filePaths[0];
  });

  ipcMain.handle(
    'omnidex:dialog:save',
    async (
      _e,
      args: {
        title?: string;
        defaultPath?: string;
        filters?: { name: string; extensions: string[] }[];
      } = {},
    ) => {
      const win = getOwnerWindow();
      const result = await (win
        ? dialog.showSaveDialog(win, {
            title: args.title ?? 'Save',
            defaultPath: args.defaultPath,
            filters: args.filters,
          })
        : dialog.showSaveDialog({
            title: args.title ?? 'Save',
            defaultPath: args.defaultPath,
            filters: args.filters,
          }));
      if (result.canceled || !result.filePath) return null;
      // Remember the path the user explicitly chose so a subsequent
      // `omnidex:fs:write-text` to it is allowed (see the write handler below).
      dialogChosenSavePaths.add(resolve(result.filePath));
      return result.filePath;
    },
  );

  // Untrusted renderer input: this handler writes to disk. Validate the payload
  // with zod, then constrain the destination to a known-safe root — either the
  // Electron userData dir, or a path the user explicitly picked via the Save
  // dialog above in this same session. `resolveWithin` realpaths the target's
  // existing-ancestor chain (allowMissing, since the file may be new) so `..`
  // traversal and symlinked parents can't escape the allowed roots. Without
  // this, a compromised renderer could overwrite any user-writable file.
  ipcMain.handle('omnidex:fs:write-text', async (_e, rawArgs: unknown) => {
    const parsed = writeTextSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid arguments' };
    }
    const { path, contents } = parsed.data;
    const target = resolve(path);
    // A path the user just chose via Save dialog is exactly the explicit-pick
    // case the spec calls safe; allow it even though it sits outside userData.
    const roots = dialogChosenSavePaths.has(target)
      ? [app.getPath('userData'), target]
      : [app.getPath('userData')];
    let safePath: string;
    try {
      safePath = resolveWithin(path, roots, { allowMissing: true });
    } catch (err) {
      return { ok: false, error: `refused to write outside allowed roots: ${(err as Error).message}` };
    }
    try {
      await writeFile(safePath, contents ?? '', 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('omnidex:dialog:open-file', async (_e, args: OpenFileArgs = {}) => {
    const win = getOwnerWindow();
    const result = await (win
      ? dialog.showOpenDialog(win, {
          title: args.title ?? 'Select a file',
          defaultPath: args.defaultPath,
          filters: args.filters,
          properties: args.multi ? ['openFile', 'multiSelections'] : ['openFile'],
        })
      : dialog.showOpenDialog({
          title: args.title ?? 'Select a file',
          defaultPath: args.defaultPath,
          filters: args.filters,
          properties: args.multi ? ['openFile', 'multiSelections'] : ['openFile'],
        }));
    if (result.canceled || result.filePaths.length === 0) return null;
    return args.multi ? result.filePaths : result.filePaths[0];
  });
}
