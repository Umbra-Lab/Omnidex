import { z } from 'zod';
import { openDatabase } from '../../db';
import { assetsRepo, tagsRepo } from '../../db/repos';
import { publicProcedure, router } from '../init';
import {
  addTagsSchema,
  idSchema,
  idsSchema,
  learnFilterSchema,
  listAssetsInputSchema,
  searchAssetsInputSchema,
  setTagsSchema,
} from '../schemas';

export const assetsRouter = router({
  totalCount: publicProcedure.query(() => assetsRepo.totalCount(openDatabase())),
  favoriteCount: publicProcedure.query(() => assetsRepo.favoriteCount(openDatabase())),
  fabCount: publicProcedure.query(() => assetsRepo.fabAssetCount(openDatabase())),

  listCards: publicProcedure
    .input(listAssetsInputSchema)
    .query(({ input }) => assetsRepo.listAssetCards(openDatabase(), input)),

  list: publicProcedure
    .input(listAssetsInputSchema)
    .query(({ input }) => assetsRepo.listAssets(openDatabase(), input)),

  get: publicProcedure
    .input(idSchema)
    .query(({ input }) => assetsRepo.getAssetById(openDatabase(), input)),

  // Other copies of the same pack across scan locations — the provenance the
  // inspector needs to answer "do I already have this somewhere else?".
  duplicates: publicProcedure
    .input(idSchema)
    .query(({ input }) => assetsRepo.duplicatesOf(openDatabase(), input)),

  count: publicProcedure
    .input(listAssetsInputSchema.shape.filter)
    .query(({ input }) => assetsRepo.countAssets(openDatabase(), input ?? null)),

  // Ranked FTS5/BM25 search (benchmarked in scripts/bench/search). Backs the
  // toolbar search box: an active query drives the asset grid from this proc in
  // relevance order, replacing the sort but NOT the sidebar filter — facets
  // intersect with the query, so a filter set before typing stays applied. The
  // `name_search` LIKE filter on `listCards` stays as a backend-only fallback.
  search: publicProcedure
    .input(searchAssetsInputSchema)
    .query(({ input }) =>
      assetsRepo.searchAssets(
        openDatabase(),
        input.query,
        input.limit,
        input.offset,
        input.filter ?? null,
      ),
    ),

  // Result count for an active query, so the status bar keeps telling the truth
  // while searching instead of falling back to the browse total.
  searchCount: publicProcedure
    .input(searchAssetsInputSchema.pick({ query: true, filter: true }))
    .query(({ input }) =>
      assetsRepo.countSearchAssets(openDatabase(), input.query, input.filter ?? null),
    ),

  categoryCounts: publicProcedure.query(() => assetsRepo.categoryCounts(openDatabase())),
  ecosystemCounts: publicProcedure.query(() => assetsRepo.ecosystemCounts(openDatabase())),
  // Per-source asset counts. Backs the sidebar's Marketplace facets: `orbital`
  // feeds the "Orbital matched" count, and "Unmatched" is its complement over
  // `totalCount` (SourceList.tsx). Both facets filter via `match_status`.
  marketplaceSourceCounts: publicProcedure.query(() =>
    assetsRepo.marketplaceSourceCounts(openDatabase()),
  ),

  setFavorite: publicProcedure
    .input(z.object({ ids: idsSchema, favorite: z.boolean() }))
    .mutation(({ input }) => {
      assetsRepo.setFavorite(openDatabase(), input.ids, input.favorite);
      return true;
    }),

  delete: publicProcedure
    .input(idsSchema)
    .mutation(({ input }) => assetsRepo.deleteAssets(openDatabase(), input)),

  // Distinct tag strings for an asset — initial state for the tagging modal.
  getTags: publicProcedure
    .input(idSchema)
    .query(({ input }) =>
      Array.from(new Set(tagsRepo.getAssetTags(openDatabase(), input).map((t) => t.tag))),
    ),

  // Replace the full user-tag set; re-serializes assets.tags so search + the
  // tag filter see the change. Invalidate assets queries on the renderer after.
  setTags: publicProcedure.input(setTagsSchema).mutation(({ input }) => {
    tagsRepo.setAssetTags(openDatabase(), input.assetId, input.tags);
    return true;
  }),

  // Add tags across a selection. Additive by design: it never removes a tag
  // the user already had, so the worst case of a misclick is one extra word.
  addTags: publicProcedure.input(addTagsSchema).mutation(({ input }) => {
    return tagsRepo.addAssetTags(openDatabase(), input.ids, input.tags);
  }),

  learnList: publicProcedure
    .input(learnFilterSchema)
    .query(({ input }) => assetsRepo.listLearnAssets(openDatabase(), input ?? {})),

  learnCounts: publicProcedure.query(() => assetsRepo.learnCounts(openDatabase())),

  stats: publicProcedure.query(() => assetsRepo.getAssetStats(openDatabase())),

  dbStats: publicProcedure.query(() => assetsRepo.getDatabaseStats(openDatabase())),
});
