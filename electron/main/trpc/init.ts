import { initTRPC } from '@trpc/server';
import superjson from 'superjson';

/**
 * Root tRPC builder for the Electron main process. `superjson` keeps `Date`,
 * `undefined`, `Map`, `Set`, etc. intact across the IPC boundary so zod-parsed
 * DB rows survive the round-trip without manual marshaling.
 *
 * The React renderer consumes this via `electron-trpc/renderer` + `@trpc/react-query`.
 * The Svelte renderer keeps using the legacy `omnidex:<channel>` `ipcMain.handle`
 * routes in `electron/main/ipc/` — both surfaces stay live through Block 6.
 */
const t = initTRPC.create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
export const mergeRouters = t.mergeRouters;
