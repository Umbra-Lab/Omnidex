import { describe, expect, it } from 'vitest';
import { subtitleStem, toWebVtt, videoStem } from '../subtitles';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,500',
  'Open the Niagara editor.',
  '',
  '2',
  '00:00:04,500 --> 00:00:09,120',
  'Then, on the emitter, set the tangent.',
  '',
].join('\n');

describe('toWebVtt', () => {
  it('adds the header SubRip lacks', () => {
    const out = toWebVtt(SRT);
    expect(out?.startsWith('WEBVTT\n\n')).toBe(true);
  });

  it('swaps the millisecond separator on timing lines', () => {
    const out = toWebVtt(SRT) ?? '';
    expect(out).toContain('00:00:01.000 --> 00:00:04.500');
    expect(out).toContain('00:00:04.500 --> 00:00:09.120');
    expect(out).not.toContain(',000 -->');
  });

  it('leaves commas in dialogue alone', () => {
    // The naive fix is a global comma replace, which turns spoken punctuation
    // into full stops.
    const out = toWebVtt(SRT) ?? '';
    expect(out).toContain('Then, on the emitter, set the tangent.');
  });

  it('keeps end timestamps, which a search-oriented parse would drop', () => {
    const out = toWebVtt(SRT) ?? '';
    expect(out.match(/-->/g)).toHaveLength(2);
  });

  it('passes an existing WebVTT file through without a second header', () => {
    const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAlready fine.\n';
    const out = toWebVtt(vtt) ?? '';
    expect(out.match(/WEBVTT/g)).toHaveLength(1);
    expect(out).toContain('Already fine.');
  });

  it('strips a UTF-8 BOM, which invalidates the header', () => {
    const out = toWebVtt(`﻿${SRT}`) ?? '';
    expect(out.startsWith('WEBVTT')).toBe(true);
  });

  it('normalizes CRLF', () => {
    const out = toWebVtt(SRT.replace(/\n/g, '\r\n')) ?? '';
    expect(out).not.toContain('\r');
    expect(out).toContain('00:00:01.000 --> 00:00:04.500');
  });

  it('preserves multi-line cue text', () => {
    const src = '1\n00:00:01,000 --> 00:00:04,000\nfirst line\nsecond line\n';
    const out = toWebVtt(src) ?? '';
    expect(out).toContain('first line\nsecond line');
  });

  it('preserves cue settings after the timing', () => {
    const src = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90% align:start\nPositioned.\n';
    expect(toWebVtt(src)).toContain('line:90% align:start');
  });

  it('is null for a file with no cues, so no empty track gets mounted', () => {
    expect(toWebVtt('')).toBeNull();
    expect(toWebVtt('WEBVTT\n\n')).toBeNull();
    expect(toWebVtt('just some prose with no timings')).toBeNull();
  });
});

describe('subtitleStem / videoStem', () => {
  it('pairs a plain sidecar with its video', () => {
    expect(subtitleStem('01 - Intro.srt')).toBe(videoStem('01 - Intro.mp4'));
  });

  it('pairs a language-tagged sidecar with its video', () => {
    expect(subtitleStem('01 - Intro.en_US.vtt')).toBe(videoStem('01 - Intro.mp4'));
    expect(subtitleStem('01 - Intro.en.srt')).toBe(videoStem('01 - Intro.mp4'));
  });

  it('pairs the <video>.<ext>.srt convention', () => {
    // What scripts/asr/backfill.py writes for every video it transcribes, and
    // what several shipped courses already use. Stripping only the subtitle
    // extension leaves "chapter_1.1.mp4", which pairs with nothing.
    expect(subtitleStem('Chapter_1.1.mp4.srt')).toBe(videoStem('Chapter_1.1.mp4'));
    expect(subtitleStem('lesson.mkv.vtt')).toBe(videoStem('lesson.mkv'));
    expect(subtitleStem('lesson.mp4.en_US.srt')).toBe(videoStem('lesson.mp4'));
  });

  it('keeps dots that are part of the lesson name', () => {
    // `Chapter 1.2 - Intro` must not lose its ".2".
    expect(subtitleStem('Chapter 1.2 - Intro.srt')).toBe(videoStem('Chapter 1.2 - Intro.mp4'));
  });

  it('does not pair different lessons', () => {
    expect(subtitleStem('01 - Intro.srt')).not.toBe(videoStem('10 - Intro.mp4'));
  });

  it('is case-insensitive, because Windows paths are', () => {
    expect(subtitleStem('01 - INTRO.SRT')).toBe(videoStem('01 - intro.mp4'));
  });
});
