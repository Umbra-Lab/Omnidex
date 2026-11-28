import { z } from 'zod';
import { enrichFab, exchangeEpicAuthCode, parseAuthorizationCode } from '../../fab/enrich';
import { defaultVaultPath, isWatching, start, stop } from '../../fab/watcher';
import { publicProcedure, router } from '../init';

/**
 * FAB action router. `enrich` delegates to the Step A service in
 * `fab/enrich.ts`; the watch procedures call `fab/watcher.ts` directly (already
 * clean service functions). No logic is reimplemented here.
 *
 * `enrich` intentionally omits `promptAuthCode`: interactive stdin re-auth is
 * impossible from the renderer, so stale credentials throw `FabAuthRequiredError`
 * (carrying the Epic redirect URL). electron-trpc's v11 error fallback drops
 * custom error `data`, so the URL can't ride the error channel — instead we
 * catch it here and fold it into a normal `reauthRequired` result the renderer
 * branches on. The CLI keeps its own stdin-backed prompt and never hits this.
 */
export const fabRouter = router({
  /** Enrich assets from the FAB library. Optional token/account overrides. */
  enrich: publicProcedure
    .input(
      z.object({ fabToken: z.string().optional(), fabAccount: z.string().optional() }).optional(),
    )
    .mutation(async ({ input }) => {
      try {
        return await enrichFab(input);
      } catch (e) {
        // Duck-typed on `name` + `redirectUrl` to stay decoupled from the error
        // class (and robust across the electron-trpc boundary).
        if (
          e &&
          typeof e === 'object' &&
          (e as { name?: string }).name === 'FabAuthRequiredError'
        ) {
          return {
            libraryItems: 0,
            updated: 0,
            unmatched: 0,
            reauthRequired: true,
            redirectUrl: (e as { redirectUrl?: string }).redirectUrl,
          };
        }
        throw e;
      }
    }),

  /**
   * Finish an Epic sign-in from the renderer: the user signed in at the
   * `redirectUrl` that `enrich` returned and pasted what Epic showed. Accepts
   * the whole JSON page or just the code. Saves the login on success.
   */
  connect: publicProcedure
    .input(z.object({ pasted: z.string().max(10_000) }))
    .mutation(async ({ input }) => {
      const code = parseAuthorizationCode(input.pasted);
      if (!code) {
        return {
          ok: false as const,
          message:
            'No authorization code found. Paste the "authorizationCode" value Epic shows after you sign in.',
        };
      }
      return exchangeEpicAuthCode(code);
    }),

  /** Start watching the FAB vault (defaults to `defaultVaultPath()`). */
  startWatch: publicProcedure.input(z.string().optional()).mutation(({ input }) => start(input)),

  /** Stop watching the FAB vault. */
  stopWatch: publicProcedure.mutation(async () => {
    await stop();
    return true;
  }),

  /** Current watch state (`{ watching, root }`). */
  isWatching: publicProcedure.query(() => isWatching()),

  /** The default FAB vault path for this platform. */
  defaultVaultPath: publicProcedure.query(() => defaultVaultPath()),
});
