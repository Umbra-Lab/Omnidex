import { create } from 'zustand';

interface UiState {
  paletteOpen: boolean;
  inspectorOpen: boolean;
  sourceListOpen: boolean;
  inspectorWidth: number;
  setPalette: (open: boolean) => void;
  togglePalette: () => void;
  toggleInspector: () => void;
  toggleSourceList: () => void;
  setInspectorWidth: (w: number) => void;
}

// Persisted width clamps. Below 360 the StatRow values ("4.8 · 21 reviews",
// "2026-04-24") wrap awkwardly and the gallery thumbnails can't breathe.
//
// The ceiling came down from 720 to 560 (DESIGN.md v2, components.inspector).
// Two reasons. At 720 on a 1600px window the three panes summed past the
// viewport and the panel's right edge fell off-screen — the resize listener
// caps at 60% of the window, which 720 clears at that size, so nothing caught
// it. And structure beats size: a 720px panel of unstructured scroll carries
// less than a tabbed 420px one, and it costs the grid a whole column.
//
// Persisted values above the ceiling are clamped on read, so anyone sitting
// at 720 lands on 560 without needing a storage-key bump.
export const INSPECTOR_MIN_WIDTH = 360;
export const INSPECTOR_MAX_WIDTH = 560;
const INSPECTOR_DEFAULT_WIDTH = 420;
// Version-suffix bumped 2026-05-07 so the new wider default (460) takes
// effect for users who had dragged a narrower width on the v6/v7 build.
// They can resize freely once it's loaded — the new value persists under
// the new key.
const INSPECTOR_WIDTH_KEY = 'omnidex.inspectorWidth.v2';

function clampInspectorWidth(w: number): number {
  return Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, w));
}

function readInspectorWidth(): number {
  if (typeof window === 'undefined') return INSPECTOR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(INSPECTOR_WIDTH_KEY);
    if (!raw) return INSPECTOR_DEFAULT_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return INSPECTOR_DEFAULT_WIDTH;
    return clampInspectorWidth(n);
  } catch {
    return INSPECTOR_DEFAULT_WIDTH;
  }
}

/**
 * Global UI chrome state — palette, inspector, source list, settings modal.
 * Small enough to stay as a single zustand slice; if it grows past ~10 keys,
 * split into per-domain slices with vanilla zustand.
 */
export const useUiStore = create<UiState>((set) => ({
  paletteOpen: false,
  inspectorOpen: false,
  sourceListOpen: true,
  inspectorWidth: readInspectorWidth(),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  toggleSourceList: () => set((s) => ({ sourceListOpen: !s.sourceListOpen })),
  setInspectorWidth: (w) => {
    const clamped = clampInspectorWidth(w);
    set({ inspectorWidth: clamped });
    try {
      window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(clamped));
    } catch {
      // localStorage can be unavailable in some sandbox configs — ignore.
    }
  },
}));
