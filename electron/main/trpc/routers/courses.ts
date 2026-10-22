import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { openDatabase } from '../../db';
import { coursesRepo } from '../../db/repos';
import { toWebVtt } from '../../scanner/subtitles';
import { publicProcedure, router } from '../init';
import { idSchema } from '../schemas';

/**
 * Learn's data surface.
 *
 * Everything here reads the manifest the scanner writes. Before it existed,
 * Learn could offer a folder name and the string "tutorial" — the only verb on
 * the screen was "open Windows Explorer".
 */
export const coursesRouter = router({
  /** Course list with duration, video/chapter counts, subtitles and progress. */
  list: publicProcedure.query(() => coursesRepo.listCourses(openDatabase())),

  get: publicProcedure
    .input(idSchema)
    .query(({ input }) => coursesRepo.getCourse(openDatabase(), input)),

  /** Chapter-ordered file list for one course, with per-lesson positions. */
  files: publicProcedure
    .input(idSchema)
    .query(({ input }) => coursesRepo.listCourseFiles(openDatabase(), input)),

  /**
   * Persist playback position. Called on a throttle from the player's
   * timeupdate, so it must stay a cheap single-row upsert.
   */
  setProgress: publicProcedure
    .input(
      z.object({
        fileId: idSchema,
        positionSeconds: z.number().min(0),
        completed: z.boolean().default(false),
      }),
    )
    .mutation(({ input }) => {
      coursesRepo.setProgress(openDatabase(), input.fileId, input.positionSeconds, input.completed);
      return true;
    }),

  /**
   * WebVTT for one lesson's subtitle sidecar, or null when it has none.
   *
   * Returned as text rather than a URL because `<track>` accepts WebVTT only,
   * and most of the library ships `.srt`. Converting in main keeps the renderer
   * from having to know either format, and means the `omnidex-asset://`
   * protocol stays a plain file streamer.
   *
   * Sidecars are a few tens of KB, fetched once per lesson, so the size is not
   * worth streaming. Failures are swallowed to null: a lesson whose captions
   * cannot be read should still play.
   */
  subtitleTrack: publicProcedure.input(idSchema).query(async ({ input }) => {
    const path = coursesRepo.subtitlePathForVideo(openDatabase(), input);
    if (!path) return null;
    try {
      const raw = await readFile(path, 'utf8');
      return toWebVtt(raw);
    } catch {
      return null;
    }
  }),

  /** Most recent unfinished lesson — drives "Resume" in the status bar. */
  lastPlayed: publicProcedure.query(() => coursesRepo.lastPlayed(openDatabase())),

  /** FTS across subtitle cues. The substrate the AI wiki would sit on. */
  searchTranscripts: publicProcedure
    .input(z.object({ query: z.string(), limit: z.number().int().positive().max(200).optional() }))
    .query(({ input }) =>
      coursesRepo.searchTranscripts(openDatabase(), input.query, input.limit ?? 50),
    ),
});
