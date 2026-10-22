import { useCallback, useMemo, useReducer } from 'react';

/**
 * Multi-selection over an ordered id list.
 *
 * The state machine is a pure reducer so it can be tested without a renderer
 * or a DOM — `useAssetSelection` below is a thin binding of it.
 *
 * Order matters: a shift-click resolves a range against `orderedIds`, so that
 * array must be in the order the user sees on screen, not the raw query order.
 *
 * Behaviour matches Explorer/Finder, which is what someone managing a
 * 3,000-item library already has in their hands:
 *   - plain click     replace the selection with this row, drop the anchor here
 *   - ctrl/cmd click  toggle this row, move the anchor here
 *   - shift click     replace with the range anchor..id, leave the anchor put
 *
 * Single selection is not a separate mode. It is a selection of size one.
 */
export interface SelectionState {
  readonly selected: ReadonlySet<number>;
  /**
   * The row the inspector follows — the last one clicked, which is not
   * necessarily the only one selected. Null when nothing is active.
   */
  readonly activeId: number | null;
  /** Where the next shift-range measures from. */
  readonly anchorId: number | null;
}

export const EMPTY_SELECTION: SelectionState = {
  selected: new Set<number>(),
  activeId: null,
  anchorId: null,
};

export type SelectionAction =
  | {
      readonly type: 'select';
      readonly id: number;
      readonly orderedIds: readonly number[];
      readonly shift?: boolean;
      readonly meta?: boolean;
    }
  | { readonly type: 'selectAll'; readonly orderedIds: readonly number[] }
  | { readonly type: 'clear' }
  | { readonly type: 'forget'; readonly ids: readonly number[] };

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'select': {
      const { id, orderedIds, shift, meta } = action;

      if (shift && state.anchorId != null) {
        const from = orderedIds.indexOf(state.anchorId);
        const to = orderedIds.indexOf(id);
        // The anchor scrolled out of the loaded window — infinite paging can
        // drop it. Degrade to a plain click rather than selecting nothing.
        if (from === -1 || to === -1) {
          return { selected: new Set([id]), activeId: id, anchorId: id };
        }
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        // Anchor deliberately stays put, so dragging the other way re-resolves
        // from the same origin instead of walking.
        return {
          selected: new Set(orderedIds.slice(lo, hi + 1)),
          activeId: id,
          anchorId: state.anchorId,
        };
      }

      if (meta) {
        const next = new Set(state.selected);
        const wasSelected = next.has(id);
        if (wasSelected) next.delete(id);
        else next.add(id);
        return {
          selected: next,
          // Toggling the active row off would leave the inspector pointing at
          // something no longer selected, which reads as a bug.
          activeId: wasSelected && state.activeId === id ? null : id,
          anchorId: id,
        };
      }

      return { selected: new Set([id]), activeId: id, anchorId: id };
    }

    case 'selectAll': {
      const first = action.orderedIds[0] ?? null;
      return {
        selected: new Set(action.orderedIds),
        activeId: state.activeId ?? first,
        anchorId: first,
      };
    }

    case 'clear':
      return EMPTY_SELECTION;

    case 'forget': {
      const gone = new Set(action.ids);
      let changed = false;
      const next = new Set<number>();
      for (const id of state.selected) {
        if (gone.has(id)) changed = true;
        else next.add(id);
      }
      const activeGone = state.activeId != null && gone.has(state.activeId);
      const anchorGone = state.anchorId != null && gone.has(state.anchorId);
      if (!changed && !activeGone && !anchorGone) return state;
      return {
        selected: changed ? next : state.selected,
        activeId: activeGone ? null : state.activeId,
        anchorId: anchorGone ? null : state.anchorId,
      };
    }

    default:
      return state;
  }
}

/** Modifier state lifted off a click event. */
export interface SelectModifiers {
  /** Shift — extend a contiguous range from the anchor. */
  readonly shift?: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS — toggle one row in place. */
  readonly meta?: boolean;
}

export interface AssetSelection {
  readonly selected: ReadonlySet<number>;
  readonly activeId: number | null;
  readonly count: number;
  readonly select: (id: number, modifiers?: SelectModifiers) => void;
  readonly selectAll: () => void;
  readonly clear: () => void;
  /** Drop deleted ids without disturbing the surviving selection. */
  readonly forget: (ids: readonly number[]) => void;
}

export function useAssetSelection(orderedIds: readonly number[]): AssetSelection {
  const [state, dispatch] = useReducer(selectionReducer, EMPTY_SELECTION);

  const select = useCallback(
    (id: number, modifiers: SelectModifiers = {}) =>
      dispatch({
        type: 'select',
        id,
        orderedIds,
        shift: modifiers.shift ?? false,
        meta: modifiers.meta ?? false,
      }),
    [orderedIds],
  );

  const selectAll = useCallback(() => dispatch({ type: 'selectAll', orderedIds }), [orderedIds]);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);
  const forget = useCallback((ids: readonly number[]) => dispatch({ type: 'forget', ids }), []);

  return useMemo(
    () => ({
      selected: state.selected,
      activeId: state.activeId,
      count: state.selected.size,
      select,
      selectAll,
      clear,
      forget,
    }),
    [state.selected, state.activeId, select, selectAll, clear, forget],
  );
}
