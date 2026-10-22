import { Boxes, FolderPlus, GraduationCap, Library, RefreshCw, Settings, Star } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useHotkey } from '@/hooks/useHotkey';
import { trpc } from '@/ipc/trpc';
import { useRuntime } from '@/runtime/useRuntime';
import { useUiStore } from '@/stores/ui';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './ui/command';
import { toast } from './ui/toaster';

interface CommandDef {
  readonly id: string;
  readonly label: string;
  readonly group: 'Navigate' | 'Actions' | 'View';
  readonly icon: typeof Boxes;
  /**
   * Key pressed alongside the platform modifier (e.g. `'1'`, `','`). The
   * modifier glyph is derived from the runtime platform at render time so we
   * don't show macOS's ⌘ on Windows/Linux.
   */
  readonly shortcutKey?: string;
  readonly run: (ctx: CommandContext) => void;
}

/**
 * Context handed to each command's `run`. Beyond navigation + UI chrome it
 * carries the real action handlers (built in `CommandPalette` where hooks are
 * available), so commands invoke live tRPC mutations rather than faking a
 * success toast.
 */
interface CommandContext {
  readonly navigate: (to: string) => void;
  readonly ui: ReturnType<typeof useUiStore.getState>;
  /** Sweep every active scan location. Progress surfaces via ScanProgressPanel. */
  readonly refreshLibrary: () => void;
  /** Go to the Folders settings tab, where a scan location gets added. */
  readonly addScanLocation: () => void;
}

function navigate(hash: string) {
  window.location.hash = hash;
}

const COMMANDS: ReadonlyArray<CommandDef> = [
  {
    id: 'nav.assets',
    label: 'Go to assets',
    group: 'Navigate',
    icon: Boxes,
    shortcutKey: '1',
    run: (ctx) => ctx.navigate('#/assets'),
  },
  {
    id: 'nav.collections',
    label: 'Go to collections',
    group: 'Navigate',
    icon: Library,
    shortcutKey: '2',
    run: (ctx) => ctx.navigate('#/collections'),
  },
  {
    id: 'nav.learn',
    label: 'Go to learn',
    group: 'Navigate',
    icon: GraduationCap,
    shortcutKey: '3',
    run: (ctx) => ctx.navigate('#/learn'),
  },
  {
    id: 'action.scan-new',
    label: 'Add a scan location',
    group: 'Actions',
    icon: FolderPlus,
    run: (ctx) => ctx.addScanLocation(),
  },
  {
    id: 'action.refresh',
    label: 'Refresh library',
    group: 'Actions',
    icon: RefreshCw,
    run: (ctx) => ctx.refreshLibrary(),
  },
  {
    id: 'view.favorites',
    label: 'Show favorites',
    group: 'View',
    icon: Star,
    run: (ctx) => ctx.navigate('#/assets'),
  },
  {
    id: 'view.settings',
    label: 'Open settings',
    group: 'View',
    icon: Settings,
    shortcutKey: ',',
    run: (ctx) => ctx.navigate('#/settings/folders'),
  },
];

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPalette);
  const toggleOpen = useUiStore((s) => s.togglePalette);
  const [search, setSearch] = useState('');

  // macOS shows the ⌘ glyph; everywhere else the modifier is Ctrl. Derive it
  // from the runtime platform so Windows/Linux don't display a Mac-only key.
  // ⌘ sits flush against its key (⌘1); the "Ctrl" word needs a separator
  // (Ctrl+1) to stay legible.
  const runtime = useRuntime();
  const isMac = runtime.platform === 'darwin';
  const formatShortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

  const utils = trpc.useUtils();
  const refreshAll = trpc.scanner.refreshAll.useMutation({
    onSuccess: () => {
      // Progress streams through ScanProgressPanel; the hook also invalidates
      // on `done`. Invalidate here too so counts settle if no event arrives.
      // Failures surface via the global mutation-cache onError toast (Infra).
      void utils.assets.invalidate();
      void utils.scanLocations.list.invalidate();
    },
  });

  const togglePalette = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      toggleOpen();
    },
    [toggleOpen],
  );

  useHotkey({ key: 'k', meta: true, handler: togglePalette });

  const ctx: CommandContext = useMemo(
    () => ({
      navigate,
      ui: useUiStore.getState(),
      refreshLibrary: () => {
        refreshAll.mutate();
        toast.success('Scan started');
      },
      addScanLocation: () => {
        navigate('#/settings/folders');
      },
    }),
    [refreshAll],
  );

  const runCommand = (cmd: CommandDef) => {
    setOpen(false);
    setSearch('');
    cmd.run(ctx);
  };

  const groups = groupBy(COMMANDS, (c) => c.group);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch('');
      }}
    >
      <CommandInput
        placeholder="Type a command or search…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {Array.from(groups.entries()).map(([group, items], idx) => (
          <div key={group}>
            {idx > 0 ? <CommandSeparator /> : null}
            <CommandGroup heading={group}>
              {items.map((cmd) => {
                const Icon = cmd.icon;
                return (
                  <CommandItem
                    key={cmd.id}
                    onSelect={() => runCommand(cmd)}
                    value={`${cmd.label} ${cmd.group}`}
                  >
                    <Icon />
                    <span>{cmd.label}</span>
                    {cmd.shortcutKey ? (
                      <CommandShortcut>{formatShortcut(cmd.shortcutKey)}</CommandShortcut>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

function groupBy<T, K extends string>(items: ReadonlyArray<T>, key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}
