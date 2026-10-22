import { router } from './init';
import { askRouter } from './routers/ask';
import { assetsRouter } from './routers/assets';
import { collectionsRouter } from './routers/collections';
import { coursesRouter } from './routers/courses';
import { fabRouter } from './routers/fab';
import { libraryHealthRouter } from './routers/library-health';
import { notesRouter } from './routers/notes';
import { orbitalRouter } from './routers/orbital';
import { progressRouter } from './routers/progress';
import { scanLocationsRouter } from './routers/scan-locations';
import { scannerRouter } from './routers/scanner';
import { settingsRouter } from './routers/settings';
import { updatesRouter } from './routers/updates';

/**
 * Root tRPC router for the React renderer. Every domain sub-router calls
 * directly into the shared repo layer in `electron/main/db/repos/` — the same
 * layer `ipcMain.handle` uses — so both renderers see consistent data.
 *
 * Export only the type to the renderer to avoid bundling server code.
 */
export const appRouter = router({
  assets: assetsRouter,
  scanLocations: scanLocationsRouter,
  collections: collectionsRouter,
  courses: coursesRouter,
  notes: notesRouter,
  settings: settingsRouter,
  scanner: scannerRouter,
  orbital: orbitalRouter,
  fab: fabRouter,
  libraryHealth: libraryHealthRouter,
  progress: progressRouter,
  ask: askRouter,
  updates: updatesRouter,
});

export type AppRouter = typeof appRouter;
