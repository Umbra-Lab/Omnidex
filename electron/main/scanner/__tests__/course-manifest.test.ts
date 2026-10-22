import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCourseManifest,
  deriveCourseTitle,
  detectTutorialSource,
  parseCues,
  parseOrderIndex,
  readMp4Duration,
  splitConcatenated,
} from '../course-manifest';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'omnidex-course-'));
  mkdirSync(join(root, '01 - Intro'), { recursive: true });
  mkdirSync(join(root, '02 - Niagara'), { recursive: true });
  mkdirSync(join(root, 'Project Files', 'Content'), { recursive: true });

  writeFileSync(join(root, '01 - Intro', '01 - Welcome.mp4'), 'x');
  writeFileSync(join(root, '01 - Intro', '01 - Welcome.srt'), '');
  writeFileSync(join(root, '01 - Intro', '10 - Later.mp4'), 'x');
  writeFileSync(join(root, '01 - Intro', '2 - Second.mp4'), 'x');
  writeFileSync(join(root, '02 - Niagara', '01 - Modules.mp4'), 'x');
  writeFileSync(join(root, 'README.pdf'), 'x');
  // Not indexable content — must not appear.
  writeFileSync(join(root, 'Project Files', 'Content', 'Thing.uasset'), 'x');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseOrderIndex', () => {
  it('reads the author ordering out of a numbered filename', () => {
    expect(parseOrderIndex('03 - GPU sprites.mp4')).toBe(3);
    expect(parseOrderIndex('10 - Later.mp4')).toBe(10);
    expect(parseOrderIndex('1.2 Make a Clicker.mp4')).toBe(1);
  });

  it('falls back to 0 when there is no leading number', () => {
    expect(parseOrderIndex('Welcome.mp4')).toBe(0);
  });
});

describe('buildCourseManifest', () => {
  it('classifies videos, subtitles and docs, and ignores everything else', async () => {
    const files = await buildCourseManifest(root);
    const kinds = files.reduce<Record<string, number>>((acc, f) => {
      acc[f.kind] = (acc[f.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kinds.video).toBe(4);
    expect(kinds.subtitle).toBe(1);
    expect(kinds.doc).toBe(1);
    // A .uasset inside a bundled sample project is not course content.
    expect(files.some((f) => f.relPath.endsWith('.uasset'))).toBe(false);
  });

  it('assigns the parent folder as the chapter, and null at the root', async () => {
    const files = await buildCourseManifest(root);
    expect(files.find((f) => f.relPath.endsWith('01 - Welcome.mp4'))?.chapter).toBe('01 - Intro');
    expect(files.find((f) => f.relPath === 'README.pdf')?.chapter).toBeNull();
  });

  it('orders by the number in the filename, not lexically', async () => {
    const files = await buildCourseManifest(root);
    const intro = files
      .filter((f) => f.chapter === '01 - Intro' && f.kind === 'video')
      .map((f) => f.relPath.split('/').pop());
    // Lexical order would put "10 - Later" before "2 - Second".
    expect(intro).toEqual(['01 - Welcome.mp4', '2 - Second.mp4', '10 - Later.mp4']);
  });

  it('uses forward slashes in rel_path regardless of platform', async () => {
    const files = await buildCourseManifest(root);
    expect(files.every((f) => !f.relPath.includes('\\'))).toBe(true);
  });

  it('leaves duration null when the file is not a readable MP4', async () => {
    // These fixtures are one byte of "x" — honest unknown beats a fake zero.
    const files = await buildCourseManifest(root, { readDurations: true });
    expect(files.filter((f) => f.kind === 'video').every((f) => f.durationSeconds === null)).toBe(
      true,
    );
  });
});

describe('readMp4Duration', () => {
  it('reads timescale and duration out of a version-0 mvhd', async () => {
    // Minimal but real MP4 box layout: ftyp, then moov > mvhd.
    const mvhdPayload = Buffer.alloc(100);
    mvhdPayload.writeUInt8(0, 0); // version 0
    mvhdPayload.writeUInt32BE(1000, 12); // timescale: 1000 ticks/sec
    mvhdPayload.writeUInt32BE(90_000, 16); // duration: 90s worth
    const mvhd = box('mvhd', mvhdPayload);
    const moov = box('moov', mvhd);
    const ftyp = box('ftyp', Buffer.from('isom'));

    const file = join(root, 'sample.mp4');
    writeFileSync(file, Buffer.concat([ftyp, moov]));
    expect(await readMp4Duration(file)).toBeCloseTo(90, 3);
  });

  it('returns null for a file that is not an MP4 at all', async () => {
    const file = join(root, 'notmp4.mp4');
    writeFileSync(file, 'this is plainly not a container');
    expect(await readMp4Duration(file)).toBeNull();
  });
});

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

describe('parseCues', () => {
  it('parses SRT', () => {
    const cues = parseCues(
      ['1', '00:00:08,120 --> 00:00:11,400', 'so the niagara ribbon renderer', ''].join('\n'),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].startMs).toBe(8120);
    expect(cues[0].text).toBe('so the niagara ribbon renderer');
  });

  it('parses WebVTT, including its dot separator and cue settings', () => {
    const cues = parseCues(
      ['WEBVTT', '', '00:01:02.500 --> 00:01:04.000 align:start', 'two ribbon emitters', ''].join(
        '\n',
      ),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].startMs).toBe(62_500);
    expect(cues[0].text).toBe('two ribbon emitters');
  });

  it('strips inline styling tags, which are not words', () => {
    const cues = parseCues('1\n00:00:01,000 --> 00:00:02,000\n<i>mesh</i> <b>emitters</b>\n');
    expect(cues[0].text).toBe('mesh emitters');
  });

  it('joins a multi-line cue into one searchable string', () => {
    const cues = parseCues('1\n00:00:01,000 --> 00:00:02,000\nfirst line\nsecond line\n');
    expect(cues[0].text).toBe('first line second line');
  });

  it('handles the hour-less MM:SS form and skips junk blocks', () => {
    const cues = parseCues(
      ['WEBVTT', '', 'NOTE this is a comment', '', '01:30.000 --> 01:32.000', 'hello', ''].join(
        '\n',
      ),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].startMs).toBe(90_000);
  });
});

describe('detectTutorialSource', () => {
  it('reads the vendor off a prefixed folder name', () => {
    expect(detectTutorialSource('Udemy - Unreal Engine 5 C++ FPS')).toBe('Udemy');
    expect(detectTutorialSource('Artstation - Fundamentals of Vegetation')).toBe('ArtStation');
    expect(detectTutorialSource('CGMA - Shading and Material Creation in UE4')).toBe('CGMA');
    expect(detectTutorialSource('The Gnomon Workshop - Creature Design')).toBe(
      'The Gnomon Workshop',
    );
    expect(detectTutorialSource('Gumroad - Houdini Water')).toBe('Gumroad');
    expect(detectTutorialSource('Rebelway - Advanced FX')).toBe('Rebelway');
  });

  it('falls back to the paths inside, which is what rescues numeric folders', () => {
    // Udemy downloads land as a bare course id; the vendor is one level in.
    expect(
      detectTutorialSource('8312980', [
        '8312980/Udemy - Ultimate Vertex Painting Masterclass/01 - Intro.mp4',
      ]),
    ).toBe('Udemy');
  });

  it('prefers the outer folder name when both mention a vendor', () => {
    expect(detectTutorialSource('Udemy - Some Course', ['bonus/Gumroad extras/thing.mp4'])).toBe(
      'Udemy',
    );
  });

  it('does NOT invent a vendor out of the subject matter', () => {
    // 118 folders in this library have "unreal" in the name and four lead with
    // "Unreal Engine 5 -". A generic prefix rule would call that a vendor.
    expect(detectTutorialSource('Unreal Engine 5 - All in one Master Bundle')).toBeNull();
    expect(detectTutorialSource('Ultimate Lighting Course')).toBeNull();
    expect(detectTutorialSource('7800094')).toBeNull();
  });

  it('still distinguishes a creator whose name contains the engine', () => {
    expect(detectTutorialSource('Unreal Sensei - Beginner Tutorial')).toBe('Unreal Sensei');
  });

  it('matches case-insensitively and inside a longer name', () => {
    expect(detectTutorialSource('Bad Decisions Studio SKILLSHARE course')).toBe('Skillshare');
  });
});

describe('duration caching across re-scans', () => {
  it('reuses a known duration when the byte size is unchanged', async () => {
    const known = new Map([['README.pdf', { size: 1, duration: 123 }]]);
    // A doc never gets a duration read, so a hit here proves the cache is
    // consulted before the reader, not after it.
    const files = await buildCourseManifest(root, { readDurations: true, knownDurations: known });
    expect(files.find((f) => f.relPath === 'README.pdf')?.durationSeconds).toBe(123);
  });

  it('ignores a cached duration when the size changed', async () => {
    const known = new Map([['README.pdf', { size: 999_999, duration: 123 }]]);
    const files = await buildCourseManifest(root, { readDurations: true, knownDurations: known });
    expect(files.find((f) => f.relPath === 'README.pdf')?.durationSeconds).toBeNull();
  });
});

describe('splitConcatenated', () => {
  it('restores spaces a download tool stripped', () => {
    expect(splitConcatenated('UdemyMegascansSceneBlackAlderForest')).toBe(
      'Udemy Megascans Scene Black Alder Forest',
    );
  });

  it('keeps an acronym together but splits the word after it', () => {
    expect(splitConcatenated('UdemyUltimateStableDiffusionAICharacterCreation')).toBe(
      'Udemy Ultimate Stable Diffusion AI Character Creation',
    );
  });

  it('leaves a name that already has spaces alone', () => {
    expect(splitConcatenated('Udemy - Already Spaced')).toBe('Udemy - Already Spaced');
  });
});

describe('deriveCourseTitle', () => {
  it('recovers the real title of a bare download id from the folder inside', () => {
    expect(
      deriveCourseTitle('7792580', ['Udemy - Unreal Engine 5 Create game in C++/01 - Intro/1.mp4']),
    ).toBe('Unreal Engine 5 Create game in C++');
  });

  it('ignores chapter folders when looking for the title', () => {
    // "01 - Introduction" is a chapter, not the course name.
    expect(
      deriveCourseTitle('8002015', ['01 - Introduction/a.mp4', 'Udmey - Chaos Destruction/b.mp4']),
    ).toBe('Chaos Destruction');
  });

  it('returns null for a bare id with nothing titled inside', () => {
    expect(deriveCourseTitle('8284831', ['01 - One/a.mp4'])).toBeNull();
  });

  it('strips the vendor prefix, which is its own column', () => {
    expect(deriveCourseTitle('Udemy - Advanced Vehicle Systems')).toBe('Advanced Vehicle Systems');
    expect(deriveCourseTitle('The Gnomon Workshop - Creature Design')).toBe('Creature Design');
  });

  it('un-mashes a concatenated name', () => {
    expect(deriveCourseTitle('UdemyMegascansSceneBlackAlderForest')).toBe(
      'Megascans Scene Black Alder Forest',
    );
  });

  it('returns null when the folder name is already fine', () => {
    expect(deriveCourseTitle('Complete VFX Niagara in Unreal Engine 5')).toBeNull();
  });
});

describe('detectTutorialSource path precedence', () => {
  it('prefers the title folder over a vendor mentioned deeper in the tree', () => {
    // Real case: 7800094 is a CGHOW course whose lesson paths also said
    // "Udemy". Searching one flat haystack attributed it to Udemy purely
    // because Udemy sits earlier in the vendor list.
    expect(
      detectTutorialSource('7800094', [
        'CGHOW - Niagara Tutorials Collection/01/a.mp4',
        'CGHOW - Niagara Tutorials Collection/02/ripped from a Udemy bundle.mp4',
      ]),
    ).toBe('CGHOW');
  });

  it('still falls through to a deeper path when no top folder names a vendor', () => {
    expect(
      detectTutorialSource('8312980', ['8312980/Udemy - Vertex Painting/01 - Intro.mp4']),
    ).toBe('Udemy');
  });
});

describe('MPEG-TS lessons', () => {
  let tsRoot: string;

  beforeAll(() => {
    tsRoot = mkdtempSync(join(tmpdir(), 'omnidex-ts-'));
    mkdirSync(join(tsRoot, 'Week 01'), { recursive: true });

    // A real transport stream: 0x47 sync byte at offset 0 and again at the
    // 188-byte packet stride.
    const packet = Buffer.alloc(376);
    packet[0] = 0x47;
    packet[188] = 0x47;
    writeFileSync(join(tsRoot, 'Week 01', '01_01 - Intro.ts'), packet);

    // TypeScript source, which is the whole reason `.ts` is sniffed rather
    // than trusted. A course teaching web development ships these.
    writeFileSync(
      join(tsRoot, 'Week 01', 'example.ts'),
      'export const answer = 42;\n// nothing video about this file\n',
    );

    // A file that happens to open with 0x47 but has no packet stride — the
    // one-byte check alone is a 1-in-256 coincidence.
    const decoy = Buffer.alloc(376);
    decoy[0] = 0x47;
    writeFileSync(join(tsRoot, 'Week 01', 'decoy.ts'), decoy);
  });

  afterAll(() => {
    rmSync(tsRoot, { recursive: true, force: true });
  });

  it('indexes a transport stream as a video', async () => {
    const files = await buildCourseManifest(tsRoot);
    const videos = files.filter((f) => f.kind === 'video');
    expect(videos.map((v) => v.relPath)).toEqual(['Week 01/01_01 - Intro.ts']);
    expect(videos[0].chapter).toBe('Week 01');
  });

  it('does not mistake TypeScript source for a lesson', async () => {
    const files = await buildCourseManifest(tsRoot);
    expect(files.some((f) => f.relPath.endsWith('example.ts'))).toBe(false);
  });

  it('requires the packet stride, not just a leading sync byte', async () => {
    const files = await buildCourseManifest(tsRoot);
    expect(files.some((f) => f.relPath.endsWith('decoy.ts'))).toBe(false);
  });
});

describe('remuxed siblings supersede the unplayable source', () => {
  let dupRoot: string;

  beforeAll(() => {
    dupRoot = mkdtempSync(join(tmpdir(), 'omnidex-dup-'));
    mkdirSync(join(dupRoot, 'Week 01'), { recursive: true });

    const ts = Buffer.alloc(376);
    ts[0] = 0x47;
    ts[188] = 0x47;
    // A lesson that has been remuxed: both files sit in the folder.
    writeFileSync(join(dupRoot, 'Week 01', '01 - Intro.ts'), ts);
    writeFileSync(join(dupRoot, 'Week 01', '01 - Intro.mp4'), Buffer.alloc(64));
    // A lesson that has NOT been remuxed yet.
    writeFileSync(join(dupRoot, 'Week 01', '02 - Later.ts'), ts);
    // A same-named file in a DIFFERENT folder must not be collapsed by it.
    mkdirSync(join(dupRoot, 'Week 02'), { recursive: true });
    writeFileSync(join(dupRoot, 'Week 02', '01 - Intro.ts'), ts);
  });

  afterAll(() => {
    rmSync(dupRoot, { recursive: true, force: true });
  });

  it('keeps the mp4 and drops the ts beside it', async () => {
    const files = await buildCourseManifest(dupRoot);
    const paths = files.filter((f) => f.kind === 'video').map((f) => f.relPath);
    expect(paths).toContain('Week 01/01 - Intro.mp4');
    expect(paths).not.toContain('Week 01/01 - Intro.ts');
  });

  it('keeps an unplayable lesson that has no remuxed sibling', async () => {
    const files = await buildCourseManifest(dupRoot);
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain('Week 01/02 - Later.ts');
  });

  it('only collapses siblings in the same folder', async () => {
    // `Week 02/01 - Intro.ts` shares a filename with the remuxed lesson in
    // Week 01 — matching on basename alone would silently delete a real lesson.
    const files = await buildCourseManifest(dupRoot);
    expect(files.map((f) => f.relPath)).toContain('Week 02/01 - Intro.ts');
  });

  it('leaves the lesson count right, not doubled', async () => {
    const files = await buildCourseManifest(dupRoot);
    expect(files.filter((f) => f.kind === 'video')).toHaveLength(3);
  });
});
