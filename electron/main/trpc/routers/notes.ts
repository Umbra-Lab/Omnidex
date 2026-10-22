import { openDatabase } from '../../db';
import { notesRepo } from '../../db/repos';
import { publicProcedure, router } from '../init';
import { idSchema, noteRequestSchema } from '../schemas';

export const notesRouter = router({
  get: publicProcedure
    .input(idSchema)
    .query(({ input }) => notesRepo.getNoteForAsset(openDatabase(), input)),

  upsert: publicProcedure
    .input(noteRequestSchema)
    .mutation(({ input }) => notesRepo.upsertNote(openDatabase(), input)),

  delete: publicProcedure.input(idSchema).mutation(({ input }) => {
    notesRepo.deleteNote(openDatabase(), input);
    return true;
  }),
});
