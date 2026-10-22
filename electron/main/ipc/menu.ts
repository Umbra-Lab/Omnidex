import { BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Main-process context menu builder. Renderer calls
 * `window.omnidex.menu.popup({ items, x, y })` with a serialized menu
 * definition; we turn it into a native electron.Menu and .popup() it on
 * the sender's BrowserWindow. Real OS menus > HTML overlays.
 */

export interface SerializedMenuItem {
  readonly id?: string;
  readonly label?: string;
  readonly type?: 'normal' | 'separator' | 'submenu';
  readonly accelerator?: string;
  readonly enabled?: boolean;
  readonly submenu?: ReadonlyArray<SerializedMenuItem>;
}

let registered = false;

export function registerMenuIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'omnidex:menu:popup',
    (
      event,
      args: {
        items: SerializedMenuItem[];
        x?: number;
        y?: number;
      },
    ) => {
      return new Promise<string | null>((resolve) => {
        let picked: string | null = null;
        const template: MenuItemConstructorOptions[] = args.items.map((item) =>
          toTemplate(item, (id) => {
            picked = id;
          }),
        );
        const menu = Menu.buildFromTemplate(template);
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) {
          resolve(null);
          return;
        }
        menu.popup({
          window: win,
          ...(args.x != null ? { x: Math.round(args.x) } : {}),
          ...(args.y != null ? { y: Math.round(args.y) } : {}),
          callback: () => resolve(picked),
        });
      });
    },
  );
}

function toTemplate(
  item: SerializedMenuItem,
  onPick: (id: string) => void,
): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' };
  const node: MenuItemConstructorOptions = {
    label: item.label,
    enabled: item.enabled ?? true,
  };
  if (item.accelerator) node.accelerator = item.accelerator;
  if (item.submenu) {
    node.type = 'submenu';
    node.submenu = item.submenu.map((c) => toTemplate(c, onPick));
  } else if (item.id) {
    const id = item.id;
    node.click = () => onPick(id);
  }
  return node;
}
