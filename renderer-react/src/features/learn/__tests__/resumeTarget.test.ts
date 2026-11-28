import { describe, expect, it } from 'vitest';
import { pickResumeTarget } from '../resumeTarget';

const lesson = (id: number, completed: number, position: number | null = null) => ({
  id,
  completed,
  position_seconds: position,
});

describe('pickResumeTarget', () => {
  it('resumes a lesson stopped partway through', () => {
    const r = pickResumeTarget([lesson(1, 1, 300), lesson(2, 0, 42), lesson(3, 0)]);
    expect(r).toEqual({ video: lesson(2, 0, 42), mode: 'resume' });
  });

  it('offers the next unfinished lesson after one is done, not the first lesson', () => {
    const r = pickResumeTarget([lesson(1, 1, 300), lesson(2, 1, 280), lesson(3, 0)]);
    expect(r).toEqual({ video: lesson(3, 0), mode: 'next' });
  });

  it('continues after the last finished lesson, even with gaps before it', () => {
    const r = pickResumeTarget([lesson(1, 0), lesson(2, 1, 280), lesson(3, 0)]);
    expect(r).toEqual({ video: lesson(3, 0), mode: 'next' });
  });

  it('goes back to an earlier gap, worded as Start, once the end is finished', () => {
    const r = pickResumeTarget([lesson(1, 0), lesson(2, 1, 280)]);
    expect(r).toEqual({ video: lesson(1, 0), mode: 'start' });
  });

  it('starts a course nobody has opened at its first lesson', () => {
    expect(pickResumeTarget([lesson(1, 0), lesson(2, 0)])).toEqual({
      video: lesson(1, 0),
      mode: 'start',
    });
  });

  it('offers the first lesson again once every lesson is done', () => {
    expect(pickResumeTarget([lesson(1, 1, 300), lesson(2, 1, 280)])).toEqual({
      video: lesson(1, 1, 300),
      mode: 'again',
    });
  });

  it('has nothing to offer for a course with no videos', () => {
    expect(pickResumeTarget([])).toBeNull();
  });
});
