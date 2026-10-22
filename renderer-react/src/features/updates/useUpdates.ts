import { UPDATE_STATE_CHANNEL } from '@omnidex/types/updates';
import { useCallback } from 'react';
import { toast } from '@/components/ui/toaster';
import { useIpcEvent } from '@/hooks/useIpcEvent';
import { trpc } from '@/ipc/trpc';
import type { UpdateAction, UpdateState } from './view';

/** The current update state. Kept fresh by `useUpdateSync`, mounted once in the shell. */
export function useUpdateState(): UpdateState | undefined {
  return trpc.updates.state.useQuery().data;
}

/**
 * Listens for the state the main process pushes on `UPDATE_STATE_CHANNEL` and
 * writes each one into the `updates.state` query cache, so any component
 * reading `useUpdateState` sees it. Mounted once, in `UpdateBanner`.
 *
 * This is a plain IPC event and not `trpc.updates.*.useSubscription`: a
 * subscription is closed by electron-trpc on the first in-app navigation. The
 * cache still refetches on window focus, which repairs any push missed while the
 * window was in the background.
 */
export function useUpdateSync(): void {
  const utils = trpc.useUtils();
  useIpcEvent<UpdateState>(
    UPDATE_STATE_CHANNEL,
    useCallback((state) => utils.updates.state.setData(undefined, state), [utils]),
  );
}

/**
 * Mutations for every update action, with the visible feedback attached in one
 * place so the banner, the About card and the menu-driven check all behave the
 * same. `pending` is true while a request is in flight, for disabling buttons.
 */
export function useUpdateActions() {
  const utils = trpc.useUtils();
  const publish = (state: UpdateState) => utils.updates.state.setData(undefined, state);
  const fail = (what: string) => (err: { message: string }) =>
    toast.error(`${what}: ${err.message}`);

  const check = trpc.updates.check.useMutation({
    onSuccess: publish,
    onError: fail('Could not check for updates'),
  });
  const download = trpc.updates.download.useMutation({
    onSuccess: publish,
    onError: fail('Could not start the download'),
  });
  const install = trpc.updates.install.useMutation({
    onSuccess: (r) => {
      if (!r.ok) toast.error('No update is ready to install');
    },
    onError: fail('Could not restart'),
  });
  const openRelease = trpc.updates.openRelease.useMutation({
    onError: fail('Could not open the release page'),
  });
  const setAutoCheck = trpc.updates.setAutoCheck.useMutation({
    onSuccess: (state, vars) => {
      publish(state);
      toast.success(vars.enabled ? 'Automatic update checks on' : 'Automatic update checks off');
    },
    onError: fail('Could not save the setting'),
  });

  const run = (action: UpdateAction): void => {
    switch (action) {
      case 'download':
      case 'retry-download':
        download.mutate();
        return;
      case 'install':
        install.mutate();
        return;
      case 'view-release':
        openRelease.mutate();
        return;
    }
  };

  return {
    check: () => check.mutate(),
    setAutoCheck: (enabled: boolean) => setAutoCheck.mutate({ enabled }),
    run,
    pending: {
      check: check.isPending,
      download: download.isPending,
      install: install.isPending,
      setAutoCheck: setAutoCheck.isPending,
    },
  };
}
