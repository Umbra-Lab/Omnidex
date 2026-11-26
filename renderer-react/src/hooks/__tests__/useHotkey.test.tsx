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

  it('ignores a bare key typed into a text field, textarea, select or contenteditable', async () => {
    const handler = vi.fn();
    await mount({ key: 'a', handler });
    const fields = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
    ];
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.append(inner);
    for (const el of [...fields, editable, inner]) {
      if (!el.isConnected) document.body.append(el.parentElement ?? el);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    }
    expect(handler).not.toHaveBeenCalled();
    for (const el of [...fields, editable]) el.remove();
  });

  it('ignores a modified shortcut typed into a field unless it opts in', async () => {
    const selectAll = vi.fn();
    const palette = vi.fn();
    await mount({ key: 'a', meta: true, handler: selectAll });
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    expect(selectAll).not.toHaveBeenCalled();

    await unmount();
    await mount({ key: 'k', meta: true, allowInInputs: true, handler: palette });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(palette).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('ignores a bare-key hotkey when ctrl, meta or alt is held', async () => {
    const handler = vi.fn();
    await mount({ key: 'r', handler });
    press('r', { ctrlKey: true }); // Ctrl+R is reload, not "reject"
    press('r', { metaKey: true });
    press('r', { altKey: true });
    expect(handler).not.toHaveBeenCalled();
    press('r', { shiftKey: true }); // shift only changes case
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not fire a meta hotkey when alt is also held', async () => {
    const handler = vi.fn();
    await mount({ key: 'k', meta: true, handler });
    press('k', { ctrlKey: true, altKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('still fires from checkboxes, radios and buttons, which take no text', async () => {
    const handler = vi.fn();
    await mount({ key: 'a', handler });
    const targets: HTMLElement[] = [];
    for (const type of ['checkbox', 'radio', 'button', 'range']) {
      const input = document.createElement('input');
      input.type = type;
      targets.push(input);
    }
    targets.push(document.createElement('button'));
    for (const el of targets) {
      document.body.append(el);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      el.remove();
    }
    expect(handler).toHaveBeenCalledTimes(targets.length);
  });

  it('treats text-like input types as editable', async () => {
    const handler = vi.fn();
    await mount({ key: 'a', handler });
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number']) {
      const input = document.createElement('input');
      input.type = type;
      document.body.append(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      input.remove();
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
