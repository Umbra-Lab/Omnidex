import { useMutation } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/toaster', () => ({ toast: { error: vi.fn() } }));
vi.mock('electron-trpc/renderer', () => ({ ipcLink: () => () => () => ({ subscribe: () => {} }) }));

import { toast } from '@/components/ui/toaster';
import { wasToasted } from '@/lib/toastedErrors';
import { TrpcProvider } from '../TrpcProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const boom = new Error('database is locked');
const seen: { caught?: unknown; quietCaught?: unknown } = {};

function Probe() {
  const loud = useMutation({ mutationFn: async () => Promise.reject(boom) });
  const quiet = useMutation({
    mutationFn: async () => Promise.reject(new Error('handled')),
    onError: () => {},
  });
  return (
    <button
      type="button"
      onClick={async () => {
        await loud.mutateAsync().catch((e: unknown) => {
          seen.caught = e;
        });
        await quiet.mutateAsync().catch((e: unknown) => {
          seen.quietCaught = e;
        });
      }}
    >
      go
    </button>
  );
}

/**
 * The app-wide mutation toast marks what it showed, so a caller awaiting the
 * same mutation (the confirm dialog) can tell and not show it twice.
 */
describe('TrpcProvider mutation errors', () => {
  it('toasts a failed mutation once and marks the error', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <TrpcProvider>
          <Probe />
        </TrpcProvider>,
      ),
    );
    await act(async () => host.querySelector('button')?.click());

    expect(seen.caught).toBe(boom);
    expect(wasToasted(boom)).toBe(true);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('database is locked');
    // A mutation with its own onError is the caller's to report.
    expect(wasToasted(seen.quietCaught)).toBe(false);

    await act(async () => root.unmount());
    host.remove();
  });
});
