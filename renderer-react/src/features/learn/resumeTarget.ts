export interface ResumeCandidate {
  readonly completed?: boolean | number | null;
  readonly position_seconds: number | null;
}

export type ResumeMode = 'resume' | 'start' | 'next' | 'again';

/**
 * Which lesson the course's play card offers, and how to word it.
 *
 * 1. A lesson you stopped partway through: Resume it.
 * 2. Otherwise the first lesson you have not finished: Start it, or call it
 *    Up next once any lesson is done. Finishing lesson 3 now offers lesson 4,
 *    where it used to fall back to lesson 1.
 * 3. Every lesson done: offer the first one again.
 */
export function pickResumeTarget<T extends ResumeCandidate>(
  videos: readonly T[],
): { readonly video: T; readonly mode: ResumeMode } | null {
  if (videos.length === 0) return null;
  const partial = videos.find((v) => !v.completed && (v.position_seconds ?? 0) > 0);
  if (partial) return { video: partial, mode: 'resume' };
  const unfinished = videos.find((v) => !v.completed);
  if (unfinished) {
    return { video: unfinished, mode: videos.some((v) => v.completed) ? 'next' : 'start' };
  }
  return { video: videos[0], mode: 'again' };
}

export const RESUME_LABEL: Record<ResumeMode, string> = {
  resume: 'Resume',
  start: 'Start',
  next: 'Up next',
  again: 'Watch again',
};
