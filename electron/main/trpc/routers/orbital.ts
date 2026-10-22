import { z } from 'zod';
import { openDatabase } from '../../db';
import { orbitalRejectionsRepo } from '../../db/repos';
import { enrichOneOrbital, enrichOrbital } from '../../orbital/enrich';
import { matchAssetName } from '../../orbital/matcher';
import { searchProducts } from '../../orbital/search';
import { publicProcedure, router } from '../init';
import { idSchema } from '../schemas';

/**
 * Orbital enrichment action router. `enrichAll` / `match` delegate to the
 * Step A service in `orbital/enrich.ts` (mutations — they write). `candidates`
 * / `search` are read-only queries that mirror the legacy `omnidex:orbital:*`
 * IPC handlers in `ipc/orbital.ts` so both surfaces stay consistent — no
 * matching/search logic is reimplemented here.
 */
export const orbitalRouter = router({
  /** Enrich every un-enriched asset against Orbital. Returns the run summary. */
  enrichAll: publicProcedure.mutation(() => enrichOrbital()),

  /** Per-card match: optional `slug` skips ranking and records that product. */
  match: publicProcedure
    .input(z.object({ assetId: idSchema, slug: z.string().optional() }))
    .mutation(({ input }) => {
      const result = enrichOneOrbital(input.assetId, input.slug);
      // Accepting a match settles the asset, so any earlier "not this one" is
      // spent. Leaving the rows would keep a now-matched pack out of a future
      // re-review, and they can no longer mean anything useful.
      orbitalRejectionsRepo.clearForAsset(openDatabase(), input.assetId);
      return result;
    }),

  /**
   * Match-queue decisions, kept so they survive a reload.
   *
   * `reject` says one listing is wrong and leaves the asset queued; `dismiss`
   * says nothing on Orbital is this pack and takes it out. See the migration
   * for why neither derives from the other.
   */
  reject: publicProcedure
    .input(z.object({ assetId: idSchema, slug: z.string().min(1) }))
    .mutation(({ input }) => {
      orbitalRejectionsRepo.rejectCandidate(openDatabase(), input.assetId, input.slug);
      return true;
    }),

  dismiss: publicProcedure.input(idSchema).mutation(({ input }) => {
    orbitalRejectionsRepo.dismissAsset(openDatabase(), input);
    return true;
  }),

  /** Put a dismissed asset back in the queue, or re-offer a rejected listing. */
  undoRejection: publicProcedure
    .input(z.object({ assetId: idSchema, slug: z.string().nullable().default(null) }))
    .mutation(({ input }) => {
      orbitalRejectionsRepo.undoRejection(openDatabase(), input.assetId, input.slug);
      return true;
    }),

  /** Slugs already turned down for one asset, so the queue can skip them. */
  rejectedSlugs: publicProcedure
    .input(idSchema)
    .query(({ input }) => orbitalRejectionsRepo.rejectedSlugsFor(openDatabase(), input)),

  /** Dry-run rank for a folder name — no write. Mirrors `omnidex:orbital:match`. */
  candidates: publicProcedure
    .input(z.object({ folderName: z.string(), limit: z.number().int().positive().optional() }))
    .query(({ input }) => matchAssetName(input.folderName, input.limit)),

  /** Free-text Orbital search — no write. Mirrors `omnidex:orbital:search`. */
  search: publicProcedure
    .input(z.object({ query: z.string(), limit: z.number().int().positive().optional() }))
    .query(({ input }) => searchProducts({ searchText: input.query, limit: input.limit })),
});
