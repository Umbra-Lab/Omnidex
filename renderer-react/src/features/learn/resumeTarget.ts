export interface ResumeCandidate {
  readonly completed?: boolean | number | null;
  readonly position_seconds: number | null;
}

export type ResumeMode = 'resume' | 'start' | 'next' | 'again';

/**
 * Which lesson the course's play card offers, and how to word it.
 *
 * 1. A lesson you stopped partway through: Resume it.
 * 2. Otherwise the first unfinished lesson after the last one you finished
 *    (Up next), so finishing lesson 3 offers lesson 4 where it used to fall
 *    back to lesson 1. With nothing finished, or only later lessons finished
 *    and nothing left after them, Start the first unfinished one.
 * 3. Every lesson done: offer the first one again.
 */
export function pickResumeTarget<T extends ResumeCandidate>(
  videos: readonly T[],
): { readonly video: T; readonly mode: ResumeMode } | null {
  if (videos.length === 0) return null;
  const partial = videos.find((v) => !v.completed && (v.position_seconds ?? 0) > 0);
  if (partial) return { video: partial, mode: 'resume' };
  // The first unfinished lesson after the last finished one, so finishing
  // lesson 3 offers lesson 4; else the first unfinished lesson anywhere.
  let lastDone = -1;
  videos.forEach((v, i) => {
    if (v.completed) lastDone = i;
  });
  const after = videos.slice(lastDone + 1).find((v) => !v.completed);
  if (after) return { video: after, mode: lastDone >= 0 ? 'next' : 'start' };
  const unfinished = videos.find((v) => !v.completed);
  if (unfinished) return { video: unfinished, mode: 'start' };
  return { video: videos[0], mode: 'again' };
}

export const RESUME_LABEL: Record<ResumeMode, string> = {
  resume: 'Resume',
  start: 'Start',
  next: 'Up next',
  again: 'Watch again',
};
