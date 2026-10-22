import { shell } from 'electron';
import { z } from 'zod';
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  setAutoCheck,
} from '../../updater';
import { publicProcedure, router } from '../init';

/**
 * Opt-in update checks (`electron/main/updater.ts`).
 *
 * `state` is the snapshot. Changes after it arrive as `omnidex:update:state`
 * IPC events (`UPDATE_STATE_CHANNEL`), which `UpdateBanner` writes into the
 * `state` query cache, so the banner and Settings → About read the same value.
 * There is deliberately no tRPC subscription here: the main process pushes and
 * the renderer only listens. (It was also the safe choice while electron-trpc
 * closed a frame's subscriptions on every hash-route change; the
 * same-document-navigation patch fixed that.)
 *
 * `check` is the only procedure that contacts GitHub on its own, and only when
 * the user invokes it. `setAutoCheck` persists the preference and, when turning
 * it on, runs one check immediately.
 */
export const updatesRouter = router({
  state: publicProcedure.query(() => getUpdateState()),

  setAutoCheck: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => setAutoCheck(input.enabled)),

  check: publicProcedure.mutation(() => checkForUpdates('manual')),

  download: publicProcedure.mutation(() => downloadUpdate()),

  install: publicProcedure.mutation(() => ({ ok: installUpdate() })),

  /** Open the releases page. The URL is fixed in main; the renderer passes nothing. */
  openRelease: publicProcedure.mutation(async () => {
    await shell.openExternal(getUpdateState().releaseUrl);
    return true;
  }),
});
