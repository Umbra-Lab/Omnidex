import { app, type BrowserWindow, crashReporter, dialog } from 'electron';
import { logLine } from './logger';

/**
 * Electron PROCESS-DEATH recovery (distinct from the JS-level
 * uncaughtException/unhandledRejection handlers in index.ts).
 *
 * The JS handlers catch exceptions thrown *inside* the running V8 isolate. They
 * cannot catch the renderer or a utility/GPU child process actually DYING —
 * a renderer OOM, a GPU-process crash, a native (addon) segfault, or a hung
 * render process. Those surface as Electron events, handled here:
 *   - webContents 'render-process-gone'  — the page's renderer died/was killed.
 *   - app 'child-process-gone'           — a utility/GPU/pepper child died.
 *   - webContents 'unresponsive'         — the renderer's main thread is hung.
 *
 * `crashReporter.start({ uploadToServer: false })` enables LOCAL minidump
 * capture (written under userData/Crashpad) so a native crash leaves a dump on
 * disk we can ask the user for — without sending anything off-device (no crash
 * server exists, and uploading would be a privacy surprise).
 *
 * On a renderer death we offer the user a Reload (re-render the page in a fresh
 * renderer) so a transient OOM doesn't strand them on a blank window; an
 * unresponsive renderer offers Reload vs Wait. Everything is logged through the
 * file logger so the event survives the quit.
 */

/**
 * Start local crash reporting. Call as early as possible at boot (before
 * windows exist) so minidumps are captured for crashes during startup too.
 */
export function startCrashReporter(): void {
  try {
    crashReporter.start({
      // Local minidumps only — we have no upload endpoint and don't want to
      // exfiltrate dumps. Dumps land under app.getPath('crashDumps').
      uploadToServer: false,
      // Don't bundle extra rate-limited metadata; a plain minidump is enough
      // for a user to send us.
      compress: true,
    });
    logLine('info', `[omnidex] crashReporter started — dumps at ${app.getPath('crashDumps')}`);
  } catch (err) {
    logLine('error', `[omnidex] crashReporter failed to start: ${(err as Error).message}`);
  }
}

/**
 * Wire the Electron process-death + unresponsive handlers for a window. Call
 * once per BrowserWindow, right after createWindow. `relaunch` reloads the
 * window's contents in place (cheaper than a full app relaunch and keeps DB /
 * IPC state).
 */
export function installCrashHandlers(win: BrowserWindow): void {
  const contents = win.webContents;

  contents.on('render-process-gone', (_event, details) => {
    const { reason, exitCode } = details;
    logLine(
      'error',
      `[omnidex] render process gone — reason=${reason} exitCode=${exitCode}`,
    );
    // 'clean-exit' is a normal teardown (e.g. window closing); don't nag.
    if (reason === 'clean-exit') return;
    if (win.isDestroyed()) return;

    const { response } = dialog.showMessageBoxSync
      ? { response: dialog.showMessageBoxSync(win, crashDialogOptions(reason)) }
      : { response: 1 };
    if (response === 0) {
      logLine('info', '[omnidex] reloading window after render-process-gone');
      // reload() re-runs the page in a fresh renderer process.
      try {
        contents.reload();
      } catch (err) {
        logLine('error', `[omnidex] reload failed, relaunching app: ${(err as Error).message}`);
        relaunchApp();
      }
    }
  });

  contents.on('unresponsive', () => {
    logLine('warn', '[omnidex] renderer unresponsive');
    if (win.isDestroyed()) return;
    const response = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Omnidex is not responding',
      message: 'Omnidex has stopped responding.',
      detail: 'You can wait for it to recover, or reload the window.',
      buttons: ['Reload', 'Keep waiting'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) {
      logLine('info', '[omnidex] reloading window after unresponsive');
      contents.reloadIgnoringCache();
    }
  });

  contents.on('responsive', () => {
    logLine('info', '[omnidex] renderer responsive again');
  });
}

/**
 * App-level child-process death handler (GPU / utility / pepper plugin). These
 * aren't tied to a single window, so register once at app-ready.
 */
export function installChildProcessHandlers(): void {
  app.on('child-process-gone', (_event, details) => {
    const { type, reason, exitCode, name } = details;
    const label = name ? `${type} (${name})` : type;
    // GPU process death is usually recoverable (Electron respawns it); log but
    // don't interrupt the user. A killed utility process is also logged only.
    logLine(
      'error',
      `[omnidex] child process gone — type=${label} reason=${reason} exitCode=${exitCode}`,
    );
  });
}

function crashDialogOptions(reason: string) {
  return {
    type: 'error' as const,
    title: 'Omnidex — Display crashed',
    message: 'The Omnidex window crashed.',
    detail: `The view process exited unexpectedly (${reason}). Reload to recover your session.`,
    buttons: ['Reload', 'Close'],
    defaultId: 0,
    cancelId: 1,
  };
}

/** Full app relaunch fallback when an in-place reload isn't possible. */
function relaunchApp(): void {
  app.relaunch();
  app.exit(0);
}
