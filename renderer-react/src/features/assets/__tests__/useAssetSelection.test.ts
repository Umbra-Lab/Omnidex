import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  type SelectionAction,
  type SelectionState,
  selectionReducer,
} from '../useAssetSelection';

const IDS = [10, 20, 30, 40, 50];

/** Fold a sequence of actions from empty, so tests read like user gestures. */
function run(...actions: readonly SelectionAction[]): SelectionState {
  return actions.reduce(selectionReducer, EMPTY_SELECTION);
}

const click = (id: number, mods: { shift?: boolean; meta?: boolean } = {}): SelectionAction => ({
  type: 'select',
  id,
  orderedIds: IDS,
  ...mods,
});

const sorted = (s: ReadonlySet<number>) => [...s].sort((a, b) => a - b);

describe('selectionReducer', () => {
  it('starts empty', () => {
    expect(EMPTY_SELECTION.selected.size).toBe(0);
    expect(EMPTY_SELECTION.activeId).toBeNull();
  });

  it('plain click replaces the selection', () => {
    const s = run(click(20), click(40));
    expect(sorted(s.selected)).toEqual([40]);
    expect(s.activeId).toBe(40);
    expect(s.anchorId).toBe(40);
  });

  it('meta click toggles one row without disturbing the rest', () => {
    const added = run(click(20), click(40, { meta: true }));
    expect(sorted(added.selected)).toEqual([20, 40]);

    const removed = selectionReducer(added, click(20, { meta: true }));
    expect(sorted(removed.selected)).toEqual([40]);
  });

  it('meta click that deselects the active row clears activeId', () => {
    const s = run(click(20), click(40, { meta: true }), click(40, { meta: true }));
    expect(sorted(s.selected)).toEqual([20]);
    expect(s.activeId).toBeNull();
  });

  it('shift click selects the inclusive range from the anchor', () => {
    const s = run(click(20), click(40, { shift: true }));
    expect(sorted(s.selected)).toEqual([20, 30, 40]);
    expect(s.activeId).toBe(40);
  });

  it('shift click works backwards and leaves the anchor put', () => {
    const back = run(click(40), click(20, { shift: true }));
    expect(sorted(back.selected)).toEqual([20, 30, 40]);
    expect(back.anchorId).toBe(40);

    // Anchor is still 40, so extending the other way re-resolves from 40
    // rather than walking from the last click.
    const forward = selectionReducer(back, click(50, { shift: true }));
    expect(sorted(forward.selected)).toEqual([40, 50]);
  });

  it('shift click with no anchor behaves like a plain click', () => {
    const s = run(click(30, { shift: true }));
    expect(sorted(s.selected)).toEqual([30]);
    expect(s.anchorId).toBe(30);
  });

  it('degrades to a plain click when the anchor left the loaded window', () => {
    const anchored = run(click(10));
    // Infinite paging dropped the head of the list; the anchor is unreachable.
    const s = selectionReducer(anchored, {
      type: 'select',
      id: 50,
      orderedIds: [30, 40, 50],
      shift: true,
    });
    expect(sorted(s.selected)).toEqual([50]);
  });

  it('selectAll takes the whole ordered list and keeps an existing active row', () => {
    const fresh = run({ type: 'selectAll', orderedIds: IDS });
    expect(fresh.selected.size).toBe(5);
    expect(fresh.activeId).toBe(10);

    const withActive = run(click(30), { type: 'selectAll', orderedIds: IDS });
    expect(withActive.activeId).toBe(30);
  });

  it('clear empties everything', () => {
    const s = run(click(20), click(40, { shift: true }), { type: 'clear' });
    expect(s.selected.size).toBe(0);
    expect(s.activeId).toBeNull();
    expect(s.anchorId).toBeNull();
  });

  it('forget drops deleted ids and keeps the survivors', () => {
    const s = run(click(20), click(40, { shift: true }), { type: 'forget', ids: [30] });
    expect(sorted(s.selected)).toEqual([20, 40]);
    expect(s.activeId).toBe(40);
  });

  it('forget clears activeId when the active row is the one deleted', () => {
    const s = run(click(30), { type: 'forget', ids: [30] });
    expect(s.selected.size).toBe(0);
    expect(s.activeId).toBeNull();
  });

  it('forget returns the same object when nothing matched', () => {
    const before = run(click(20));
    const after = selectionReducer(before, { type: 'forget', ids: [999] });
    // Identity matters: a new object here would re-render every card.
    expect(after).toBe(before);
  });
});
