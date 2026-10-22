import { z } from 'zod';
import { openDatabase } from '../../db';
import { scanLocationsRepo } from '../../db/repos';
import { publicProcedure, router } from '../init';
import { idSchema, scanLocationInputSchema, scanLocationUpdateSchema } from '../schemas';

export const scanLocationsRouter = router({
  list: publicProcedure.query(() => scanLocationsRepo.listScanLocations(openDatabase())),

  // Per-location asset count, bytes on disk, and last-scanned stamp. Kept off
  // `list` because it aggregates the whole `assets` table — the folder rows
  // render immediately and fill these in when the aggregate lands.
  stats: publicProcedure.query(() => scanLocationsRepo.listScanLocationStats(openDatabase())),

  get: publicProcedure
    .input(idSchema)
    .query(({ input }) => scanLocationsRepo.getScanLocation(openDatabase(), input)),

  create: publicProcedure
    .input(scanLocationInputSchema)
    .mutation(({ input }) => scanLocationsRepo.createScanLocation(openDatabase(), input)),

  setActive: publicProcedure
    .input(z.object({ id: idSchema, is_active: z.boolean() }))
    .mutation(({ input }) => {
      scanLocationsRepo.updateScanLocationActive(openDatabase(), input.id, input.is_active);
      return true;
    }),

  // Partial edit (name/path/active/recursive/extensions/description/content
  // format). Only the provided fields are written. Changing content_format takes
  // effect on the location's next scan, which restamps every asset under it.
  // Invalidate scanLocations.list on the renderer.
  update: publicProcedure.input(scanLocationUpdateSchema).mutation(({ input }) => {
    const { id, ...fields } = input;
    scanLocationsRepo.updateScanLocationFull(openDatabase(), id, fields);
    return true;
  }),

  delete: publicProcedure.input(idSchema).mutation(({ input }) => {
    scanLocationsRepo.deleteScanLocation(openDatabase(), input);
    return true;
  }),
});
