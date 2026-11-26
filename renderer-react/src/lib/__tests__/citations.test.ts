import { describe, expect, it } from 'vitest';
import {
  subtitlePairsWith as mainSubtitlePairsWith,
  subtitleStem as mainSubtitleStem,
  videoStem as mainVideoStem,
} from '../../../../electron/main/scanner/subtitles';
import { splitAnswer } from '../citations';
import { subtitlePairsWith, subtitleStem, videoStem } from '../subtitleStem';

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
    'A/Lesson.EN.srt',
    'A/Lesson.mp4.PT-BR.vtt',
    '10 - Later/04 UE5 Set-Up.mp4',
  ];
  it('renderer copies match electron/main/scanner/subtitles.ts', () => {
    for (const c of cases) {
      expect(subtitleStem(c)).toBe(mainSubtitleStem(c));
      expect(videoStem(c)).toBe(mainVideoStem(c));
    }
  });

  it('pairs like the main process, including names ending in a two-letter word', () => {
    const pairs: [string, string][] = [
      ['A/Intro.UE.srt', 'A/Intro.UE.mp4'],
      ['A/Menus.ui.srt', 'A/Menus.ui.mp4'],
      ['A/Lesson.EN.srt', 'A/Lesson.mp4'],
      ['A/lesson.mp4.srt', 'A/lesson.mp4'],
      ['A/01 - Intro.srt', 'A/10 - Intro.mp4'],
    ];
    for (const [sub, video] of pairs) {
      expect(subtitlePairsWith(sub, video)).toBe(mainSubtitlePairsWith(sub, video));
    }
    expect(subtitlePairsWith('A/Intro.UE.srt', 'A/Intro.UE.mp4')).toBe(true);
  });

  it('pairs the Whisper sidecar shape with its video', () => {
    expect(subtitleStem('A/lesson.mp4.srt')).toBe(videoStem('A/lesson.mp4'));
    expect(subtitleStem('A/lesson.srt')).toBe(videoStem('A/lesson.mp4'));
    expect(subtitleStem('A/lesson.en_US.vtt')).toBe(videoStem('A/lesson.mp4'));
  });
});
