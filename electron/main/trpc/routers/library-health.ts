import { openDatabase } from '../../db';
import { scanDiagnosticsRepo } from '../../db/repos';
import { publicProcedure, router } from '../init';
import { diagnosticListSchema } from '../schemas';

/**
 * Library Health — what the scanner could not index. Read-only: the rows are
 * written by the scan pipeline, never by the renderer.
 */
export const libraryHealthRouter = router({
  /** Counts per diagnostic kind, biggest bucket first. */
  summary: publicProcedure.query(() => scanDiagnosticsRepo.summary(openDatabase())),

  /** Drill-down into one kind. Capped server-side — see the repo. */
  list: publicProcedure
    .input(diagnosticListSchema)
    .query(({ input }) => scanDiagnosticsRepo.listByKind(openDatabase(), input.kind, input.limit)),
});
