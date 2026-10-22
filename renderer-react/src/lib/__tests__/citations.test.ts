import { describe, expect, it } from 'vitest';
import { splitAnswer } from '../citations';
import { subtitleStem, videoStem } from '../subtitleStem';
import {
  subtitleStem as mainSubtitleStem,
  videoStem as mainVideoStem,
} from '../../../../electron/main/scanner/subtitles';

describe('splitAnswer', () => {
  it('splits text around citation markers', () => {
    const parts = splitAnswer('Set the tangent [[4812@754]] then save [[4812@800.5]].');
    expect(parts).toEqual([
      { kind: 'text', text: 'Set the tangent ' },
      { kind: 'cite', lessonId: 4812, seconds: 754 },
      { kind: 'text', text: ' then save ' },
      { kind: 'cite', lessonId: 4812, seconds: 800.5 },
      { kind: 'text', text: '.' },
    ]);
  });

  it('returns plain text untouched', () => {
    expect(splitAnswer('no citations here')).toEqual([{ kind: 'text', text: 'no citations here' }]);
  });

  it('leaves malformed markers visible as text', () => {
    const parts = splitAnswer('broken [[abc@12]] marker');
    expect(parts).toEqual([{ kind: 'text', text: 'broken [[abc@12]] marker' }]);
  });
});

describe('subtitleStem parity with the main process', () => {
  const cases = [
    'Chapter 1.2 - Intro/lesson.mp4.srt',
    'A/lesson.srt',
    'A/lesson.en_US.vtt',
    'A/lesson.English.srt',
    '10 - Later/04 UE5 Set-Up.mp4',
  ];
  it('renderer copies match electron/main/scanner/subtitles.ts', () => {
    for (const c of cases) {
      expect(subtitleStem(c)).toBe(mainSubtitleStem(c));
      expect(videoStem(c)).toBe(mainVideoStem(c));
    }
  });

  it('pairs the Whisper sidecar shape with its video', () => {
    expect(subtitleStem('A/lesson.mp4.srt')).toBe(videoStem('A/lesson.mp4'));
    expect(subtitleStem('A/lesson.srt')).toBe(videoStem('A/lesson.mp4'));
    expect(subtitleStem('A/lesson.en_US.vtt')).toBe(videoStem('A/lesson.mp4'));
  });
});
