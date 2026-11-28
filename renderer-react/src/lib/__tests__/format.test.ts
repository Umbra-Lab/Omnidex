import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  formatPrice,
  formatRating,
  formatSupportedVersions,
  formatTaxonomyLabel,
  lessonTitle,
} from '../format';

describe('formatBytes', () => {
  it('renders an em dash for non-positive or non-finite input', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('keeps raw bytes with no decimal under 1 KB', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('suffixes a "+" when the size is only a lower bound', () => {
    expect(formatBytes(26.7 * 1024 ** 3, true)).toBe('27 GB+');
    expect(formatBytes(1024, true)).toBe('1.0 KB+');
    // Unknown size stays an em dash — "—+" would be nonsense.
    expect(formatBytes(0, true)).toBe('—');
  });

  it('steps up exactly at the 1024 boundary', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('shows one decimal below 10 and no decimal at/above 10 within a unit', () => {
    expect(formatBytes(1536)).toBe('1.5 KB'); // 1.5 * 1024
    expect(formatBytes(9.4 * 1024)).toBe('9.4 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('caps at TB rather than inventing a PB unit', () => {
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB');
  });
});

describe('formatCount', () => {
  it('groups thousands with the en-US separator', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(1_000_000)).toBe('1,000,000');
  });

  it('coerces null / undefined / non-finite to "0"', () => {
    expect(formatCount(null)).toBe('0');
    expect(formatCount(undefined)).toBe('0');
    expect(formatCount(Number.NaN)).toBe('0');
  });
});

describe('formatPrice', () => {
  it('renders "Free" for zero, negative, or missing price', () => {
    expect(formatPrice(0)).toBe('Free');
    expect(formatPrice(-5)).toBe('Free');
    expect(formatPrice(null)).toBe('Free');
    expect(formatPrice(undefined)).toBe('Free');
  });

  it('renders a 2-decimal dollar amount otherwise', () => {
    expect(formatPrice(39.99)).toBe('$39.99');
    expect(formatPrice(5)).toBe('$5.00');
    expect(formatPrice(0.5)).toBe('$0.50');
  });
});

describe('formatRating', () => {
  it('renders one decimal place', () => {
    expect(formatRating(4.84)).toBe('4.8');
    expect(formatRating(5)).toBe('5.0');
    expect(formatRating(0)).toBe('0.0');
  });

  it('renders an em dash for missing / non-finite ratings', () => {
    expect(formatRating(null)).toBe('—');
    expect(formatRating(undefined)).toBe('—');
    expect(formatRating(Number.NaN)).toBe('—');
  });
});

describe('formatSupportedVersions', () => {
  const json = (v: unknown) => JSON.stringify(v);

  it('renders an em dash for missing, malformed, or empty input', () => {
    expect(formatSupportedVersions(null)).toBe('—');
    expect(formatSupportedVersions(undefined)).toBe('—');
    expect(formatSupportedVersions('')).toBe('—');
    expect(formatSupportedVersions('not json')).toBe('—');
    expect(formatSupportedVersions(json([]))).toBe('—');
    expect(formatSupportedVersions(json(['', '  ']))).toBe('—');
  });

  it('collapses a contiguous run into a single range', () => {
    expect(formatSupportedVersions(json(['5.0', '5.1', '5.2', '5.3']))).toBe('5.0 – 5.3');
  });

  it('treats 4.27 → 5.0 as contiguous', () => {
    expect(formatSupportedVersions(json(['4.26', '4.27', '5.0', '5.1']))).toBe('4.26 – 5.1');
  });

  it('splits non-contiguous runs and renders lone versions bare', () => {
    expect(formatSupportedVersions(json(['4.26', '5.1', '5.2']))).toBe('4.26, 5.1 – 5.2');
    expect(formatSupportedVersions(json(['5.3']))).toBe('5.3');
  });

  it('sorts numerically, not lexically, and drops duplicates', () => {
    // Lexical sort would put 5.10 before 5.9 and break the range.
    expect(formatSupportedVersions(json(['5.10', '5.9', '5.9', '5.11']))).toBe('5.9 – 5.11');
  });

  it("passes through Orbital's pre-collapsed labels verbatim", () => {
    expect(formatSupportedVersions(json(['UE 5.1–5.4']))).toBe('5.1–5.4');
    expect(formatSupportedVersions(json(['UE 5.2+']))).toBe('5.2+');
    expect(formatSupportedVersions(json(['UE 5.2']))).toBe('5.2');
  });
});

describe('formatTaxonomyLabel', () => {
  it('replaces enum fallbacks that were never user-chosen categories', () => {
    expect(formatTaxonomyLabel('unknown')).toBe('Unclassified');
    expect(formatTaxonomyLabel('agnostic')).toBe('Engine-agnostic');
  });

  it('cleans separators that CSS capitalize left behind', () => {
    // The sidebar used to render this literally as "Unreal_engine".
    expect(formatTaxonomyLabel('unreal_engine')).toBe('Unreal Engine');
    expect(formatTaxonomyLabel('Tool-And-Plugin')).toBe('Tool and plugin');
    expect(formatTaxonomyLabel('game_template')).toBe('Game template');
  });

  it('preserves acronyms instead of sentence-casing them into mush', () => {
    expect(formatTaxonomyLabel('3d-Model')).toBe('3D model');
    expect(formatTaxonomyLabel('vfx')).toBe('VFX');
    expect(formatTaxonomyLabel('ui')).toBe('UI');
  });

  it('uses sentence case, not title case', () => {
    expect(formatTaxonomyLabel('game-system')).toBe('Game system');
  });

  it('guards empty and nullish input', () => {
    expect(formatTaxonomyLabel(null)).toBe('Unclassified');
    expect(formatTaxonomyLabel(undefined)).toBe('Unclassified');
    expect(formatTaxonomyLabel('   ')).toBe('Unclassified');
  });
});

describe('formatDuration', () => {
  it('shows seconds under a minute instead of "0m"', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(0.4)).toBe('1s');
  });
  it('shows minutes, then hours with padded minutes', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(14 * 60 + 29)).toBe('14m');
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe('2h 05m');
  });
  it('is a dash for nothing', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('formatClock', () => {
  it('is m:ss under an hour', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(247)).toBe('4:07');
  });
  it('is h:mm:ss past an hour, not 62:03', () => {
    expect(formatClock(3723)).toBe('1:02:03');
  });
  it('treats junk as zero', () => {
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('lessonTitle', () => {
  it('drops folders and the video extension', () => {
    expect(lessonTitle('01 Intro/1. Modeling a crate.mp4')).toBe('1. Modeling a crate');
    expect(lessonTitle('Chapter 2\\03 - Bevels.MKV')).toBe('03 - Bevels');
  });
  it('keeps other dots and non-video extensions', () => {
    expect(lessonTitle('v1.2 update notes.pdf')).toBe('v1.2 update notes.pdf');
    expect(lessonTitle('Part 1.5 - UVs.webm')).toBe('Part 1.5 - UVs');
  });
  it('never returns an empty name', () => {
    expect(lessonTitle('.mp4')).toBe('.mp4');
  });
});
