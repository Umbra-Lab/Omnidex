import { useCallback } from 'react';
import type { SerializedMenuItem } from '@/types/omnidex';

export interface ContextMenuItem extends SerializedMenuItem {
  readonly onSelect?: () => void;
}

/**
 * Build a native OS context menu via electron.Menu.popup() from the main
 * process. Returns an onContextMenu handler suitable for any element:
 *
 *   <div onContextMenu={openMenu(items)} />
 *
 * Each item's `onSelect` runs in the renderer after the user picks it.
 */
export function useNativeContextMenu() {
  return useCallback(
    (items: ReadonlyArray<ContextMenuItem>) => async (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const bridge = window.omnidex?.menu?.popup;
      if (!bridge) return;
      const serialized = items.map(({ onSelect: _onSelect, ...rest }) => rest);
      const picked = await bridge({
        items: serialized,
        x: event.clientX,
        y: event.clientY,
      });
      if (picked == null) return;
      const match = items.find((i) => i.id === picked);
      match?.onSelect?.();
    },
    [],
  );
}

/**
 * Handlers a view supplies to build the standard asset context menu. Keeps the
 * trpc/modal wiring in the view (which has the mutations + `useModals`) while
 * this helper owns the menu shape so every grid shows the same items.
 */
export interface AssetMenuActions {
  readonly id: number;
  /** Absolute file path, used for "Reveal in Finder"; omitted when unknown. */
  readonly filePath: string | null;
  readonly isFavorite: boolean;
  readonly onToggleFavorite: () => void;
  readonly onAddToCollection: () => void;
  readonly onManageTags: () => void;
  readonly onDelete: () => void;
}

/**
 * Build the canonical asset context-menu item list. Views call this with their
 * own mutation/modal callbacks, then feed the result to `openMenu(...)`. The
 * "Reveal in Finder" entry is disabled (and a no-op) when no file path exists.
 */
export function buildAssetMenuItems(actions: AssetMenuActions): ContextMenuItem[] {
  const { filePath, isFavorite } = actions;
  return [
    {
      id: 'reveal',
      label: 'Reveal in Finder',
      enabled: Boolean(filePath),
      onSelect: () => {
        if (filePath) void window.omnidex?.shell?.openFileLocation(filePath);
      },
    },
    { id: 'sep-1', type: 'separator' },
    {
      id: 'favorite',
      label: isFavorite ? 'Remove favorite' : 'Add favorite',
      onSelect: actions.onToggleFavorite,
    },
    {
      id: 'add-collection',
      label: 'Add to collection…',
      onSelect: actions.onAddToCollection,
    },
    {
      id: 'manage-tags',
      label: 'Manage tags…',
      onSelect: actions.onManageTags,
    },
    { id: 'sep-2', type: 'separator' },
    {
      id: 'delete',
      label: 'Delete',
      onSelect: actions.onDelete,
    },
  ];
}
