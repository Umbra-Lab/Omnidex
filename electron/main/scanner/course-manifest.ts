import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';

/**
 * Course manifest: what is actually inside a course folder.
 *
 * Learn knew a course's name and nothing else, so the screen could only offer
 * a folder name and the word "tutorial". Everything it wants — duration, video
 * count, chapters, whether subtitles exist — is one walk away, and that walk
 * is also the substrate for transcript search later.
 *
 * No new dependency. Durations come from parsing the MP4 header directly
 * (~40 lines below); ffprobe would mean shipping a binary, and loading each
 * file into a <video> element to read `duration` would mean reading hundreds
 * of gigabytes to render a list.
 */

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv']);
const SUBTITLE_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub']);
const DOC_EXT = new Set(['.pdf', '.md', '.txt', '.doc', '.docx', '.rtf', '.epub']);
/**
 * Sealed content. A course delivered as a 26-part RAR is 50 GB of real
 * material with nothing indexable in it, and recording that is the difference
 * between "this course has 0 videos" (a lie) and "extract it first" (the
 * truth). Multi-part names end `.part07.rar`, so the final extension alone is
 * enough to catch them.
 */
const ARCHIVE_EXT = new Set(['.rar', '.zip', '.7z', '.tar', '.gz', '.iso']);
/**
 * Extensions that are video often enough to check, but not to assume.
 *
 * `.ts` is MPEG-2 Transport Stream and also TypeScript, and a course teaching
 * web development ships plenty of the latter. Adding it to `VIDEO_EXT` would
 * quietly turn source files into lessons and inflate every video count and
 * duration total in Learn.
 *
 * So these are sniffed instead of trusted. This is not hypothetical: one real
 * 27.6 GB course (`CGMA - Shading and Material Creation in UE4`, 44 lessons
 * across six weeks) was walked, sized correctly, and then dropped entirely —
 * it had no manifest at all because every one of its files ended `.ts`.
 */
const AMBIGUOUS_VIDEO_EXT = new Set(['.ts']);

/**
 * Video containers Chromium cannot decode in a `<video src>`. Indexed anyway —
 * they carry chapter order and searchable transcripts — but superseded by a
 * remuxed `.mp4` sibling when one exists.
 */
const UNPLAYABLE_VIDEO_EXT = new Set(['.ts', '.m2ts', '.mts']);

/**
 * ISO base media containers, the only ones `readMp4Duration` can parse (it
 * walks `moov` > `mvhd`). Every other video reads as null, so a null cached for
 * one of those is the final answer and is never worth another file open.
 */
const DURATION_READABLE_EXT = new Set(['.mp4', '.m4v', '.mov']);

const extLower = (p: string): string => {
  const dot = p.lastIndexOf('.');
  return dot === -1 ? '' : p.slice(dot).toLowerCase();
};
const stripExt = (p: string): string => p.replace(/\.[^./\\]+$/, '').toLowerCase();

/**
 * True when a file is really an MPEG-2 Transport Stream.
 *
 * TS is a fixed 188-byte packet format, each packet starting with sync byte
 * 0x47. Checking two packets rather than one is what makes this a real test: a
 * lone 0x47 at offset 0 is a 1-in-256 coincidence, while 0x47 at both 0 and 188
 * is the packet stride and essentially cannot happen by accident in a text
 * file. Any read failure means "not a video" — a file we cannot open is not one
 * we can index.
 */
async function isMpegTs(path: string): Promise<boolean> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, 'r');
    const buf = Buffer.alloc(189);
    const { bytesRead } = await handle.read(buf, 0, 189, 0);
    return bytesRead === 189 && buf[0] === 0x47 && buf[188] === 0x47;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}
/** Course art. Many courses ship a cover beside the lessons. */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** Folders that are course scaffolding, not chapters. */
const IGNORED = new Set(['.git', 'node_modules', '__macosx', '.ds_store']);

/**
 * Folders Unity regenerates inside a project. A course that ships its project files
 * (`Assets/` beside `ProjectSettings/`) would otherwise list thousands of cached package
 * docs and images from `Library/` as lessons' materials, and pick one as the cover.
 */
const UNITY_GENERATED = new Set(['library', 'temp', 'logs', 'obj', 'usersettings']);

/** Stop walking absurdly deep trees; a course is not 12 levels of nesting. */
const MAX_DEPTH = 6;

export type CourseFileKind = 'video' | 'subtitle' | 'doc' | 'archive' | 'image';

export interface CourseFile {
  readonly relPath: string;
  readonly absPath: string;
  readonly kind: CourseFileKind;
  readonly chapter: string | null;
  readonly orderIndex: number;
  readonly sizeBytes: number;
  readonly durationSeconds: number | null;
}

/**
 * A leading number in a filename is the author's ordering — "03 - GPU
 * sprites" comes after "02 - …" regardless of how it sorts lexically ("10"
 * before "2"). Falls back to 0 so unnumbered files keep their scan order.
 */
export function parseOrderIndex(name: string): number {
  const m = /^\s*(\d{1,4})\b/.exec(name);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function classify(ext: string): CourseFileKind | null {
  if (VIDEO_EXT.has(ext)) return 'video';
  if (SUBTITLE_EXT.has(ext)) return 'subtitle';
  if (DOC_EXT.has(ext)) return 'doc';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

/**
 * Read an MP4's duration from its `mvhd` box.
 *
 * Layout: the file is a flat sequence of boxes [4-byte size][4-byte type].
 * `moov` contains `mvhd`, whose payload holds a timescale (ticks per second)
 * and a duration in ticks. Version 0 uses 32-bit fields at offsets 12/16;
 * version 1 uses 64-bit at 20/24.
 *
 * A fragmented MP4 (DASH downloads, some screen recorders) puts its samples in
 * `moof` fragments and writes 0 into `mvhd`, or all ones for "unknown". Those
 * values are not durations: 0 showed the lesson as 0:00 and pulled the course
 * total down, and because 0 is not null it was cached and never read again.
 * For those files the duration comes from `moov > mvex > mehd` (the whole
 * fragmented length), or else from a top-level `sidx` (the segment index,
 * summed). With neither, the answer is null.
 *
 * Returns null for anything that is not a readable MP4 — MKV and AVI need
 * entirely different parsers, and a wrong number is worse than no number.
 */
export async function readMp4Duration(path: string): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    let offset = 0;
    let sawMoov = false;
    // Set once a segment index is read: its length, and the byte it says the
    // indexed fragments end at. Fragments past that byte mean the index only
    // covered part of the file.
    let indexed: { seconds: number; coversTo: number } | null = null;

    // Top-level scan. `moov` is usually first or last; either way we only read
    // 16 bytes per box header, not the payloads.
    while (offset < size - 8) {
      const head = Buffer.alloc(16);
      const { bytesRead } = await handle.read(head, 0, 16, offset);
      if (bytesRead < 8) break;

      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        // 64-bit extended size lives in the next 8 bytes.
        if (bytesRead < 16) break;
        boxSize = Number(head.readBigUInt64BE(8));
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset; // box runs to EOF
      }
      if (boxSize < headerLen) break;

      if (indexed) {
        // Past the indexed range, only trailing boxes (mfra, free) may follow.
        // Another fragment or index means one sidx per fragment, and the first
        // index alone would report a 30-minute lesson as 2 seconds.
        if (type === 'moof' || type === 'sidx') return null;
      } else if (type === 'moov') {
        sawMoov = true;
        const movie = await readMovieDuration(handle, offset + headerLen, offset + boxSize);
        if (movie.seconds !== null) return movie.seconds;
      } else if (type === 'sidx' && sawMoov) {
        indexed = await readSidxDuration(handle, offset + headerLen, offset + boxSize);
        if (!indexed) return null;
        // Jump to where the index says its fragments end, and check the rest.
        offset = Math.max(offset + boxSize, indexed.coversTo);
        continue;
      } else if (type === 'moof' && sawMoov) {
        // Fragments without a segment index ahead of them: there is nothing
        // short of walking every fragment, so stop here rather than read on.
        return null;
      }
      offset += boxSize;
    }
    return indexed?.seconds ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** True for the values `mvhd`/`mehd` use to mean "not recorded here". */
function isUnknownTicks(ticks: number, version: number): boolean {
  return ticks === 0 || (version === 0 ? ticks === 0xffffffff : ticks >= 2 ** 53);
}

/**
 * Walk `moov`'s children. Returns seconds when `mvhd` (or, for a fragmented
 * file, `mvex > mehd`) holds a real duration, and the movie timescale either
 * way so the caller knows a `moov` was readable.
 */
async function readMovieDuration(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
): Promise<{ seconds: number | null; timescale: number }> {
  let timescale = 0;
  let mvhdTicks: number | null = null;
  let mehdTicks: number | null = null;
  let offset = start;
  while (offset < end - 8) {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, offset);
    if (bytesRead < 8) break;
    const boxSize = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (boxSize < 8) break;

    if (type === 'mvhd') {
      const payload = Buffer.alloc(Math.min(boxSize - 8, 40));
      await handle.read(payload, 0, payload.length, offset + 8);
      const version = payload.readUInt8(0);
      if (version === 1) {
        if (payload.length < 32) break;
        timescale = payload.readUInt32BE(20);
        const ticks = Number(payload.readBigUInt64BE(24));
        mvhdTicks = isUnknownTicks(ticks, 1) ? null : ticks;
      } else {
        if (payload.length < 20) break;
        timescale = payload.readUInt32BE(12);
        const ticks = payload.readUInt32BE(16);
        mvhdTicks = isUnknownTicks(ticks, 0) ? null : ticks;
      }
    } else if (type === 'mvex') {
      mehdTicks = await readMehdWithin(handle, offset + 8, offset + boxSize);
    }
    offset += boxSize;
  }
  if (timescale <= 0) return { seconds: null, timescale: 0 };
  const ticks = mvhdTicks ?? mehdTicks;
  return { seconds: ticks === null ? null : ticks / timescale, timescale };
}

/** `mvex > mehd`: the fragment_duration of the whole movie, in movie ticks. */
async function readMehdWithin(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
): Promise<number | null> {
  let offset = start;
  while (offset < end - 8) {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, offset);
    if (bytesRead < 8) return null;
    const boxSize = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (boxSize < 8) return null;
    if (type === 'mehd') {
      const payload = Buffer.alloc(Math.min(boxSize - 8, 12));
      await handle.read(payload, 0, payload.length, offset + 8);
      const version = payload.readUInt8(0);
      if (version === 1) {
        if (payload.length < 12) return null;
        const ticks = Number(payload.readBigUInt64BE(4));
        return isUnknownTicks(ticks, 1) ? null : ticks;
      }
      if (payload.length < 8) return null;
      const ticks = payload.readUInt32BE(4);
      return isUnknownTicks(ticks, 0) ? null : ticks;
    }
    offset += boxSize;
  }
  return null;
}

/**
 * A top-level `sidx` indexes the fragments that follow it. Its timescale is its
 * own (usually the media track's), and each reference carries a subsegment
 * duration and a byte size. Summed, the durations are the length of what it
 * indexes, and `coversTo` is the byte where that ends, so the caller can check
 * nothing follows. An index that points at other indexes (reference_type 1) is
 * hierarchical; rather than follow it, give up.
 */
async function readSidxDuration(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  end: number,
): Promise<{ seconds: number; coversTo: number } | null> {
  const fixed = Buffer.alloc(32);
  const { bytesRead } = await handle.read(fixed, 0, Math.min(32, end - start), start);
  if (bytesRead < 4) return null;
  const version = fixed.readUInt8(0);
  // version/flags 4, reference_ID 4, timescale 4, then earliest presentation
  // time and first offset (4+4 in v0, 8+8 in v1), reserved 2, count 2.
  const countAt = version === 0 ? 20 : 28;
  if (bytesRead < countAt + 4) return null;
  const timescale = fixed.readUInt32BE(8);
  const firstOffset = version === 0 ? fixed.readUInt32BE(16) : Number(fixed.readBigUInt64BE(20));
  // 16-bit count, so the reference list is at most 786 KB.
  const count = fixed.readUInt16BE(countAt + 2);
  if (timescale <= 0 || count === 0) return null;

  const refsStart = start + countAt + 4;
  if (refsStart + count * 12 > end) return null;
  const refs = Buffer.alloc(count * 12);
  const read = await handle.read(refs, 0, refs.length, refsStart);
  if (read.bytesRead < refs.length) return null;
  let ticks = 0;
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const typeAndSize = refs.readUInt32BE(i * 12);
    if (typeAndSize >>> 31 === 1) return null; // points at another sidx
    bytes += typeAndSize & 0x7fffffff;
    ticks += refs.readUInt32BE(i * 12 + 4);
  }
  if (ticks <= 0) return null;
  // Offsets count from the first byte after the sidx box.
  return { seconds: ticks / timescale, coversTo: end + firstOffset + bytes };
}

/**
 * Walk one course folder and describe what is in it.
 *
 * `readDurations` is opt-in because it costs a file open per video. The
 * scanner passes true; a caller that only wants counts can skip it.
 */
export async function buildCourseManifest(
  courseRoot: string,
  options: {
    readonly readDurations?: boolean;
    /**
     * Duration already known for a file, keyed by rel_path, valid only while
     * the byte size is unchanged.
     *
     * Without this a re-scan pays a file open per video forever — on this
     * library ~9,000 opens to re-learn what has not changed. Size is the
     * guard: a re-encoded or replaced lesson has a different length, so a
     * stale duration cannot survive an edit.
     */
    readonly knownDurations?: ReadonlyMap<string, { size: number; duration: number | null }>;
  } = {},
): Promise<CourseFile[]> {
  const out: CourseFile[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirNames = new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase()),
    );
    const unityProject = dirNames.has('assets') && dirNames.has('projectsettings');
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED.has(entry.name.toLowerCase())) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (unityProject && UNITY_GENERATED.has(entry.name.toLowerCase())) continue;
        await walk(abs, depth + 1);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      // `classify` stays pure and synchronous — the sniff is a narrow async
      // fallback for the handful of extensions that need one, so the common
      // path costs nothing.
      let kind = classify(ext);
      if (!kind && AMBIGUOUS_VIDEO_EXT.has(ext) && (await isMpegTs(abs))) kind = 'video';
      if (!kind) continue;

      const rel = relative(courseRoot, abs);

      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(abs)).size;
      } catch {
        // Unreadable file: still record it, size unknown rather than absent.
      }

      const relPath = rel.split(sep).join('/');
      // Reuse a duration already on record, but only while the bytes match.
      // A recorded null for a container the reader understands is a failed
      // read, not an answer: reusing it would pin the lesson at "unknown
      // length" forever, so it is retried while duration reading is on. A
      // recorded 0 is the same: older scans stored a fragmented MP4's empty
      // `mvhd` as 0 seconds, and a real lesson is never 0 long.
      const cached = options.knownDurations?.get(relPath);
      const known = cached?.duration != null && cached.duration > 0;
      const reuse =
        cached != null &&
        cached.size === sizeBytes &&
        (known || !options.readDurations || !DURATION_READABLE_EXT.has(ext));

      out.push({
        relPath,
        absPath: abs,
        kind,
        // Filled in by `assignChapters` once every file is known.
        chapter: null,
        orderIndex: parseOrderIndex(basename(entry.name)),
        sizeBytes,
        durationSeconds: reuse
          ? cached.duration
          : options.readDurations && kind === 'video'
            ? await readMp4Duration(abs)
            : null,
      });
    }
  }

  await walk(courseRoot, 0);

  // Drop an unplayable source when a remuxed sibling sits beside it.
  //
  // `scripts/remux-unplayable.mjs` writes `lesson.mp4` next to `lesson.ts` and
  // deliberately keeps the original, so the user can verify before deleting
  // 27 GB. Without this the next scan indexes both and every lesson appears
  // twice in the chapter list — once watchable, once not, with nothing on
  // screen to say which is which.
  //
  // Keyed on the full path minus extension, so it only ever collapses a true
  // sibling pair in the same folder.
  const playableStems = new Set(
    out
      .filter((f) => f.kind === 'video' && !UNPLAYABLE_VIDEO_EXT.has(extLower(f.relPath)))
      .map((f) => stripExt(f.relPath)),
  );
  const deduped = out.filter(
    (f) =>
      !(
        f.kind === 'video' &&
        UNPLAYABLE_VIDEO_EXT.has(extLower(f.relPath)) &&
        playableStems.has(stripExt(f.relPath))
      ),
  );
  out.length = 0;
  out.push(...deduped);

  const chaptered = assignChapters(out);
  out.length = 0;
  out.push(...chaptered);

  // Chapter order first, then the subfolder inside the chapter (files directly
  // in the chapter come first), then the author's numbering. All fall back to a
  // locale-aware compare so unnumbered files stay stable.
  out.sort((a, b) => {
    const ch = (a.chapter ?? '').localeCompare(b.chapter ?? '', undefined, { numeric: true });
    if (ch !== 0) return ch;
    const dir = compareDirs(a.relPath, b.relPath);
    if (dir !== 0) return dir;
    if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
    return a.relPath.localeCompare(b.relPath, undefined, { numeric: true });
  });
  return out;
}

/** A section folder the author numbered: "01 - Intro", "3. Basics", "10_Extras". */
const NUMBERED_FOLDER = /^\d/;

/**
 * Folder part of a forward-slash relative path; `''` at the course root.
 */
function dirOf(relPath: string): string {
  const cut = relPath.lastIndexOf('/');
  return cut < 0 ? '' : relPath.slice(0, cut);
}

/**
 * Order two files of one chapter by the folder they sit in. Files directly in
 * the chapter folder sort before its subfolders; subfolders sort numerically.
 */
export function compareDirs(a: string, b: string): number {
  const da = dirOf(a);
  const db = dirOf(b);
  if (da === db) return 0;
  // Segment by segment, so "Videos/Extra" stays with "Videos" rather than
  // sorting after "Videos-old" the way a whole-string compare would.
  const sa = da === '' ? [] : da.split('/');
  const sb = db === '' ? [] : db.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i += 1) {
    const c = sa[i].localeCompare(sb[i], undefined, { numeric: true });
    if (c !== 0) return c;
  }
  return sa.length - sb.length;
}

/**
 * Set each file's chapter to the section folder it belongs to.
 *
 * A course is one root over many sections, and a section often keeps its
 * lessons in subfolders (`01 - Intro/Videos`, `01 - Intro/Exercises`). The
 * chapter is therefore the first folder under the course root, not the file's
 * own parent: keying on the parent merged every section's `Videos` folder into
 * one chapter.
 *
 * A wrapper is a run of leading folders above the sections
 * (`Course/Niagara Masterclass/01 - Intro/...`), and it is skipped. A folder is
 * part of the wrapper when every video at or below its depth sits inside it and
 * some video sits deeper still, so a stray `Trailer.mp4` at the root or an
 * `Intro.mp4` directly in the wrapper doesn't stop the skip; those videos get
 * no chapter. A numbered folder (`01 - Intro`) is a section rather than a
 * wrapper unless the folders inside it are numbered too, so a course with one
 * numbered section keeps it as its chapter. Files outside
 * the wrapper, such as a cover at the root, use their own first folder, or
 * none.
 */
export function assignChapters(files: readonly CourseFile[]): CourseFile[] {
  const videoDirs = files
    .filter((f) => f.kind === 'video')
    .map((f) => dirOf(f.relPath))
    .map((d) => (d === '' ? [] : d.split('/')));
  const prefix: string[] = [];
  for (;;) {
    const k = prefix.length;
    // Videos that still have a folder at this depth.
    const below = videoDirs.filter((d) => d.length > k && prefix.every((p, i) => d[i] === p));
    const name = below[0]?.[k];
    if (name == null || !below.every((d) => d[k] === name)) break;
    const next = below.filter((d) => d.length > k + 1).map((d) => d[k + 1]);
    if (next.length === 0) break;
    // "2024 Course/01 - Intro" is a wrapper; "01 - Intro/Videos" is a section.
    if (NUMBERED_FOLDER.test(name) && !next.every((n) => NUMBERED_FOLDER.test(n))) break;
    prefix.push(name);
  }
  return files.map((f) => {
    const dir = dirOf(f.relPath);
    const segs = dir === '' ? [] : dir.split('/');
    const inWrapper = prefix.every((p, i) => segs[i] === p);
    const rest = inWrapper ? segs.slice(prefix.length) : segs;
    return { ...f, chapter: rest[0] ?? null };
  });
}

/**
 * Course vendors, matched against the folder name and the paths inside it.
 *
 * An allowlist, not "whatever precedes the dash". This library has 118 course
 * folders with "unreal" in the name and four leading with "Unreal Engine 5 -",
 * so a generic prefix rule would invent a vendor called Unreal Engine. Only
 * names we can actually attribute get attributed.
 *
 * Order matters where one name contains another — "Unreal Sensei" is a
 * creator, not the engine.
 */
const KNOWN_SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bunreal\s+sensei\b/i, 'Unreal Sensei'],
  [/\bmotion\s+design\s+school\b/i, 'Motion Design School'],
  [/\b(?:the\s+)?gnomon(?:\s+workshop)?\b/i, 'The Gnomon Workshop'],
  [/\budemy\b/i, 'Udemy'],
  // Misspelled on disk in this library. Same vendor.
  [/\budmey\b/i, 'Udemy'],
  [/\bcghow\b/i, 'CGHOW'],
  [/\bartstation\b/i, 'ArtStation'],
  [/\bskillshare\b/i, 'Skillshare'],
  [/\bcoloso\b/i, 'Coloso'],
  [/\bgumroad\b/i, 'Gumroad'],
  [/\bdomestika\b/i, 'Domestika'],
  [/\bcgma\b/i, 'CGMA'],
  [/\bcgcircuit\b/i, 'CGCircuit'],
  [/\bflippednormals\b/i, 'FlippedNormals'],
  [/\bwingfox\b/i, 'Wingfox'],
  [/\bclass101\b/i, 'Class101'],
  [/\brebelway\b/i, 'Rebelway'],
  [/\bpluralsight\b/i, 'Pluralsight'],
  [/\bschoolism\b/i, 'Schoolism'],
  [/\bfxphd\b/i, 'fxphd'],
  [/\bpackt\b/i, 'Packt'],
  [/\bcg\s?cookie\b/i, 'CG Cookie'],
  [/\bepic\s+games\b/i, 'Epic Games'],
  [/\bpatreon\b/i, 'Patreon'],
];

/**
 * Where a course came from, read off the folder name — and failing that, off
 * the paths inside it.
 *
 * The inner-path fallback is what rescues the numeric folders. Udemy downloads
 * often land as a bare course id (`8312980`), but one level in sits
 * `8312980/Udemy - Ultimate Vertex Painting Masterclass/…`. That is evidence,
 * not inference, which is why this reads real paths instead of assuming a
 * 7-digit folder must be Udemy.
 *
 * The outer name wins when both match: a folder you filed under "Udemy - …"
 * is a Udemy course even if one lesson mentions Gumroad.
 */
export function detectTutorialSource(
  courseName: string,
  innerPaths: readonly string[] = [],
): string | null {
  const match = (hay: string): string | null => {
    for (const [re, label] of KNOWN_SOURCES) if (re.test(hay)) return label;
    return null;
  };

  const fromName = match(courseName);
  if (fromName) return fromName;

  // Top-level folders inside the course, checked before anything deeper. A
  // CGHOW course had a lesson path mentioning Udemy further down, and
  // searching one flat haystack let the wrong vendor win purely because
  // Udemy sits earlier in KNOWN_SOURCES. The title folder is the evidence.
  for (const seg of new Set(innerPaths.map((path) => path.split('/')[0]))) {
    const hit = match(seg);
    if (hit) return hit;
  }

  return match(innerPaths.join('\n'));
}

export interface CueRow {
  readonly startMs: number;
  readonly text: string;
}

/**
 * Parse SRT or WebVTT into cues.
 *
 * Both formats are the same shape — an optional index line, a timing line with
 * `-->`, then text until a blank line. VTT uses `.` for the millisecond
 * separator and SRT uses `,`; everything else that differs (styling blocks,
 * NOTE lines, cue settings) is ignorable for search.
 */
export function parseCues(source: string): CueRow[] {
  const cues: CueRow[] = [];
  // Normalise CRLF and old-Mac CR-only endings, then split on any line that is
  // blank or holds only whitespace. A `\n{2,}` split merged two cues whenever
  // the separator carried a stray space, and the second timing line landed in
  // the first cue's searchable text.
  const blocks = source.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n(?:[ \t]*\n)*/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;

    const startRaw = lines[timingIdx].split('-->')[0].trim();
    const startMs = parseTimestamp(startRaw);
    if (startMs == null) continue;

    const text = lines
      .slice(timingIdx + 1)
      // Strip inline tags (<i>, <c.colorE5E5E5>) — they are styling, not words.
      .map((l) => l.replace(/<[^>]+>/g, '').trim())
      .filter(Boolean)
      .join(' ');
    if (text) cues.push({ startMs, text });
  }
  return cues;
}

function parseTimestamp(raw: string): number | null {
  // [HH:]MM:SS[,.]mmm
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(raw.trim());
  if (!m) return null;
  const h = m[1] ? Number.parseInt(m[1], 10) : 0;
  const min = Number.parseInt(m[2], 10);
  const sec = Number.parseInt(m[3], 10);
  const ms = Number.parseInt(m[4].padEnd(3, '0'), 10);
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/**
 * Split a CamelCase / concatenated folder name back into words.
 *
 * Course folders arrive as `UdemyMegascansSceneBlackAlderForest` often enough
 * to matter — the download tool stripped the spaces. Boundaries are a lower→
 * upper transition, and the tail of an acronym run before a capitalised word
 * (`AICharacter` → `AI Character`), so `UnrealEngine5` keeps its digit.
 */
export function splitConcatenated(raw: string): string {
  if (raw.includes(' ')) return raw;
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/** Vendor prefix at the head of a folder name, e.g. "Udemy - ". */
const VENDOR_PREFIX_RE =
  /^\s*[[(]?\s*(?:udemy|udmey|artstation|skillshare|coloso|gumroad|domestika|cgma|cgcircuit|cghow|flippednormals|wingfox|class101|rebelway|pluralsight|schoolism|fxphd|packt|patreon|the\s+gnomon\s+workshop|gnomon|epic\s+games|cg\s?cookie)\s*[\])]?\s*(?:[-–—_|]+\s*|\s+)/i;

/**
 * A human title for a course, derived from what is on disk.
 *
 * Three problems, no network needed for any of them:
 *
 *  1. Bare download ids. 21 courses here are named `7792580`, which tells the
 *     user nothing. In 18 of those the real title is the single named folder
 *     one or two levels in — `Udemy - Unreal Engine 5 Create game in C++`.
 *  2. Concatenated names, `UdemyMegascansSceneBlackAlderForest`.
 *  3. The vendor prefix, which is already shown as its own column, so
 *     repeating it in the title is noise.
 *
 * Returns null when the folder name is already a decent title — the caller
 * keeps `name` rather than storing a duplicate.
 */
export function deriveCourseTitle(
  folderName: string,
  innerPaths: readonly string[] = [],
): string | null {
  const isBareId = /^\d{4,}$/.test(folderName.trim());

  let candidate = folderName;
  if (isBareId) {
    // First path segment that reads like a title rather than an id or a
    // chapter number. Chapters look like "01 - Intro"; titles have real words.
    const named = innerPaths
      .map((p) => p.split('/')[0])
      .find((seg) => seg && /[A-Za-z]{4}/.test(seg) && !/^\d+\s*[-.]/.test(seg));
    if (!named) return null;
    candidate = named;
  }

  const cleaned = splitConcatenated(candidate).replace(VENDOR_PREFIX_RE, '').trim();
  if (!cleaned) return null;
  // Nothing changed and the original was fine — no point storing a copy.
  return cleaned === folderName ? null : cleaned;
}
