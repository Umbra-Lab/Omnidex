import { z } from 'zod';
import { openDatabase } from '../../db';
import { collectionsRepo } from '../../db/repos';
import { publicProcedure, router } from '../init';
import { createCollectionSchema, idSchema, idsSchema } from '../schemas';

export const collectionsRouter = router({
  list: publicProcedure.query(() => collectionsRepo.listCollections(openDatabase())),

  get: publicProcedure
    .input(idSchema)
    .query(({ input }) => collectionsRepo.getCollection(openDatabase(), input)),

  // Member assets of a collection, projected as cards for the detail grid.
  assets: publicProcedure
    .input(idSchema)
    .query(({ input }) => collectionsRepo.listCollectionAssetCards(openDatabase(), input)),

  create: publicProcedure
    .input(createCollectionSchema)
    .mutation(({ input }) => collectionsRepo.createCollection(openDatabase(), input)),

  delete: publicProcedure.input(idSchema).mutation(({ input }) => {
    collectionsRepo.deleteCollection(openDatabase(), input);
    return true;
  }),

  addAssets: publicProcedure
    .input(z.object({ collection_id: idSchema, asset_ids: idsSchema }))
    .mutation(({ input }) => {
      collectionsRepo.addAssetsToCollection(openDatabase(), input.collection_id, input.asset_ids);
      return true;
    }),

  removeAssets: publicProcedure
    .input(z.object({ collection_id: idSchema, asset_ids: idsSchema }))
    .mutation(({ input }) => {
      collectionsRepo.removeAssetsFromCollection(
        openDatabase(),
        input.collection_id,
        input.asset_ids,
      );
      return true;
    }),
});
