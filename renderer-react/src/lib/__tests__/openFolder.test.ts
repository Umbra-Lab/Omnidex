import { afterEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/toaster', () => ({ toast: { error: toastError } }));

import { openFolder } from '../openFolder';

type Shell = { openFileLocation: (p: string) => Promise<{ ok: boolean; error?: string }> };

function withShell(shell: Shell | undefined) {
  (window as unknown as { omnidex?: { shell?: Shell } }).omnidex = shell ? { shell } : undefined;
}

afterEach(() => {
  toastError.mockReset();
  withShell(undefined);
});

describe('openFolder', () => {
  it('opens quietly when the shell manages it', async () => {
    const openFileLocation = vi.fn(async () => ({ ok: true }));
    withShell({ openFileLocation });
    await expect(openFolder('E:/Packs/Rocks')).resolves.toBe(true);
    expect(openFileLocation).toHaveBeenCalledWith('E:/Packs/Rocks');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('says a moved pack is gone', async () => {
    withShell({ openFileLocation: async () => ({ ok: false, error: 'not found' }) });
    await expect(openFolder('E:/Packs/Rocks')).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("isn't there any more"));
  });

  it('points at Settings for a paused scan folder', async () => {
    withShell({ openFileLocation: async () => ({ ok: false, error: 'path not allowed' }) });
    await openFolder('E:/Packs/Rocks');
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Settings → Folders'));
  });

  it('reports a failure it has no words for, and a thrown one', async () => {
    withShell({ openFileLocation: async () => ({ ok: false, error: 'EACCES' }) });
    await openFolder('E:/x');
    expect(toastError).toHaveBeenLastCalledWith("Couldn't open the folder: EACCES");
    withShell({
      openFileLocation: async () => {
        throw new Error('ipc closed');
      },
    });
    await openFolder('E:/x');
    expect(toastError).toHaveBeenLastCalledWith("Couldn't open the folder: ipc closed");
  });

  it('says it needs the desktop app without a bridge', async () => {
    await expect(openFolder('E:/x')).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledWith('Opening folders only works in the desktop app.');
  });
});
