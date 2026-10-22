import { ipcMain, Notification } from 'electron';

/**
 * Thin wrapper around electron.Notification for the renderer. Emits real
 * OS notifications (Notification Center on macOS, Action Center on Win11).
 * Used by scan completion events and update-available banners.
 */
let registered = false;

export function registerNotificationIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'omnidex:notify',
    (_event, args: { title: string; body?: string; silent?: boolean }) => {
      if (!Notification.isSupported()) return false;
      const notification = new Notification({
        title: args.title,
        body: args.body ?? '',
        silent: args.silent ?? false,
      });
      notification.show();
      return true;
    },
  );
}
