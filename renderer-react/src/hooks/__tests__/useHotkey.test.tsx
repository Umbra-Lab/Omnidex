import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHotkey } from '../useHotkey';

// React's act() needs this flag when used outside a dedicated test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HotkeyProps = Parameters<typeof useHotkey>[0];

// `key` is a reserved React prop, so the options can't be spread directly onto
// a component — they go through a single `opts` prop instead.
function Harness({ opts }: { opts: HotkeyProps }) {
  useHotkey(opts);
  return null;
}

let mounted: { root: Root; container: HTMLElement } | null = null;

// Awaiting act() flushes the passive effect (the keydown listener attaches)
// before the test dispatches anything — otherwise the listener is registered
// asynchronously, after the assertion has already run.
async function mount(props: HotkeyProps): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness opts={props} />);
  });
  mounted = { root, container };
}

async function unmount(): Promise<void> {
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  mounted = null;
}

function press(key: string, modifiers: Partial<KeyboardEventInit> = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, ...modifiers }));
}

afterEach(async () => {
  await unmount();
});

describe('useHotkey', () => {
  it('fires the handler on a bare key match', async () => {
    const handler = vi.fn();
    await mount({ key: 'k', handler });
    press('k');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('matches the key case-insensitively', async () => {
    const handler = vi.fn();
    await mount({ key: 'k', handler });
    press('K');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores keys that do not match', async () => {
    const handler = vi.fn();
    await mount({ key: 'k', handler });
    press('j');
    expect(handler).not.toHaveBeenCalled();
  });

  it('requires meta/ctrl when meta is set, accepting either modifier', async () => {
    const handler = vi.fn();
    await mount({ key: 'p', meta: true, handler });

    press('p'); // no modifier → ignored
    expect(handler).not.toHaveBeenCalled();

    press('p', { metaKey: true });
    expect(handler).toHaveBeenCalledTimes(1);

    press('p', { ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('requires shift when shift is set', async () => {
    const handler = vi.fn();
    await mount({ key: 'o', meta: true, shift: true, handler });

    press('o', { metaKey: true }); // missing shift
    expect(handler).not.toHaveBeenCalled();

    press('o', { metaKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not register a listener when disabled', async () => {
    const handler = vi.fn();
    await mount({ key: 'k', enabled: false, handler });
    press('k');
    expect(handler).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount', async () => {
    const handler = vi.fn();
    await mount({ key: 'k', handler });
    press('k');
    expect(handler).toHaveBeenCalledTimes(1);

    await unmount();

    press('k');
    expect(handler).toHaveBeenCalledTimes(1); // no further calls
  });
});
