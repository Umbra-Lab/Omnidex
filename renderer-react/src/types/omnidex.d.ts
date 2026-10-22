/**
 * Global bridge type for `window.omnidex`. Mirrors the preload surface at
 * electron/preload/index.ts. Kept in one file so merge-augmented Window
 * declarations elsewhere don't partially redeclare the shape (TS errors out
 * on conflicting overlapping fields).
 */
declare global {
  interface Window {
    readonly omnidex?: OmnidexBridge;
  }
}

export interface OmnidexBridge {
  readonly runtime: 'electron';
  readonly platform: string;
  readonly versions: {
    readonly electron?: string;
    readonly chrome?: string;
    readonly node?: string;
  };
  readonly shell?: {
    openFileLocation: (p: string) => Promise<{ ok: boolean; error?: string }>;
    openExternal: (p: string) => Promise<{ ok: boolean; error?: string }>;
    openPath: (p: string) => Promise<{ ok: boolean; error?: string }>;
  };
  readonly dialog?: {
    openFolder: (args?: {
      title?: string;
      defaultPath?: string;
      multi?: boolean;
    }) => Promise<string | string[] | null>;
    openFile: (args?: {
      title?: string;
      defaultPath?: string;
      multi?: boolean;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<string | string[] | null>;
  };
  readonly fileUrl?: (path: string) => string;
  readonly events?: {
    on: (channel: string, handler: (payload: unknown) => void) => () => void;
  };
  readonly menu?: {
    popup: (args: {
      items: SerializedMenuItem[];
      x?: number;
      y?: number;
    }) => Promise<string | null>;
  };
  readonly notify?: {
    show: (args: { title: string; body?: string; silent?: boolean }) => Promise<boolean>;
  };
}

export interface SerializedMenuItem {
  readonly id?: string;
  readonly label?: string;
  readonly type?: 'normal' | 'separator' | 'submenu';
  readonly accelerator?: string;
  readonly enabled?: boolean;
  readonly submenu?: ReadonlyArray<SerializedMenuItem>;
}
