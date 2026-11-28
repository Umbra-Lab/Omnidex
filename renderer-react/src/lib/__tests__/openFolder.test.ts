import { afterEach, describe, expect, it, vi } from 'vitest';

const { toastError, toastInfo } = vi.hoisted(() => ({ toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('@/components/ui/toaster', () => ({ toast: { error: toastError, info: toastInfo } }));

import { openFolder } from '../openFolder';

type Shell = {
  openFileLocation: (p: string) => Promise<{ ok: boolean; error?: string; openedParent?: boolean }>;
};

function withShell(shell: Shell | undefined) {
  (window as unknown as { omnidex?: { shell?: Shell } }).omnidex = shell ? { shell } : undefined;
}

afterEach(() => {
  toastError.mockReset();
  toastInfo.mockReset();
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

  it('says a moved pack is gone when its parent opened instead', async () => {
    withShell({ openFileLocation: async () => ({ ok: true, openedParent: true }) });
    await expect(openFolder('E:/Packs/Rocks')).resolves.toBe(true);
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining("isn't there any more"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('suggests reconnecting when the whole location is unavailable', async () => {
    withShell({ openFileLocation: async () => ({ ok: false, error: 'not found' }) });
    await expect(openFolder('E:/Packs/Rocks')).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("isn't connected"));
  });

  it('points at Settings for a path outside the scan folders', async () => {
    withShell({ openFileLocation: async () => ({ ok: false, error: 'path not allowed' }) });
    await openFolder('E:/Packs/Rocks');
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('outside your scan folders'));
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Settings → Folders'));
  });

  it('reports a failure it has no words for, and a thrown one', async () => {
    withShell({ openFileLocation: async () => ({ ok: false, error: 'EACCES' }) });
    await openFolder('E:/x');
    expect(toastError).toHaveBeenLastCalledWith("Couldn't open that location: EACCES");
    withShell({
      openFileLocation: async () => {
        throw new Error('ipc closed');
      },
    });
    await openFolder('E:/x');
    expect(toastError).toHaveBeenLastCalledWith("Couldn't open that location: ipc closed");
  });

  it('says it needs the desktop app without a bridge', async () => {
    await expect(openFolder('E:/x')).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledWith('Opening folders only works in the desktop app.');
  });
});
