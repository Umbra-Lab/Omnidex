import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSPECTOR_MAX_WIDTH, INSPECTOR_MIN_WIDTH, useUiStore } from '../ui';

const WIDTH_KEY = 'omnidex.inspectorWidth.v2';

// Snapshot the action-bearing initial state so each test starts clean. We only
// reset the data fields, leaving the action functions intact.
const initial = {
  paletteOpen: useUiStore.getState().paletteOpen,
  inspectorOpen: useUiStore.getState().inspectorOpen,
  sourceListOpen: useUiStore.getState().sourceListOpen,
};

// jsdom 27 / Node 25 expose a partial `window.localStorage` (no `.clear()`, and
// the store swallows write errors in a try/catch). Install a deterministic
// in-memory implementation so persistence is actually observable.
function installLocalStorage(): void {
  const map = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
  Object.defineProperty(window, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  installLocalStorage();
  useUiStore.setState(initial);
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useUiStore — boolean chrome toggles', () => {
  it('ships with sane defaults (source list open, everything else closed)', () => {
    const s = useUiStore.getState();
    expect(s.paletteOpen).toBe(false);
    expect(s.inspectorOpen).toBe(false);
    expect(s.sourceListOpen).toBe(true);
  });

  it('togglePalette / toggleInspector / toggleSourceList flip their own flag only', () => {
    useUiStore.getState().togglePalette();
    expect(useUiStore.getState().paletteOpen).toBe(true);
    expect(useUiStore.getState().inspectorOpen).toBe(false);

    useUiStore.getState().toggleInspector();
    expect(useUiStore.getState().inspectorOpen).toBe(true);

    useUiStore.getState().toggleSourceList();
    expect(useUiStore.getState().sourceListOpen).toBe(false);

    // Toggling again returns to the original value.
    useUiStore.getState().togglePalette();
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it('setPalette sets an explicit value', () => {
    useUiStore.getState().setPalette(true);
    expect(useUiStore.getState().paletteOpen).toBe(true);
    useUiStore.getState().setPalette(false);
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });
});

describe('useUiStore — inspector width clamping + persistence', () => {
  it('clamps a too-small width up to the minimum', () => {
    useUiStore.getState().setInspectorWidth(100);
    expect(useUiStore.getState().inspectorWidth).toBe(INSPECTOR_MIN_WIDTH);
  });

  it('clamps a too-large width down to the maximum', () => {
    useUiStore.getState().setInspectorWidth(9999);
    expect(useUiStore.getState().inspectorWidth).toBe(INSPECTOR_MAX_WIDTH);
  });

  it('keeps an in-range width verbatim', () => {
    useUiStore.getState().setInspectorWidth(500);
    expect(useUiStore.getState().inspectorWidth).toBe(500);
  });

  it('persists the clamped width to localStorage under the v2 key', () => {
    useUiStore.getState().setInspectorWidth(10_000);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe(String(INSPECTOR_MAX_WIDTH));

    useUiStore.getState().setInspectorWidth(420);
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('420');
  });

  it('still updates state when localStorage.setItem throws (sandboxed config)', () => {
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceeded / blocked');
        },
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      },
      configurable: true,
      writable: true,
    });

    expect(() => useUiStore.getState().setInspectorWidth(500)).not.toThrow();
    expect(useUiStore.getState().inspectorWidth).toBe(500);
  });
});
