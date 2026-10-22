/**
 * Serving subtitle sidecars to a `<video>` element.
 *
 * The library ships `.srt` and `.vtt` beside lessons, and the scanner already
 * indexes both into `transcript_fts` for search. Showing them to the viewer is
 * a different problem: HTML `<track>` accepts WebVTT and nothing else, so an
 * `.srt` mounted directly is silently ignored by every browser.
 *
 * This is deliberately a rewrite, not a re-parse. `parseCues` in
 * `course-manifest.ts` reduces a file to `(startMs, text)` because that is all
 * search needs — it drops end times, positioning cues and styling, which is
 * exactly the information captions are made of. Round-tripping through it would
 * produce captions that never disappear.
 *
 * WebVTT and SubRip differ in only two things that matter here: the `WEBVTT`
 * header, and `,` versus `.` as the millisecond separator. Everything else —
 * cue numbers, the `-->` line, multi-line text — is already valid WebVTT. So
 * the conversion touches the header and the timing lines and leaves the rest of
 * the file byte-for-byte alone.
 */

/** A timing line: `00:00:01,000 --> 00:00:04,000` with optional cue settings. */
const TIMING_LINE = /-->/;

/**
 * Normalize a subtitle sidecar into WebVTT.
 *
 * Accepts either format. Returns null when the source has no cue at all, so a
 * caller can distinguish "no captions" from "empty captions" and skip mounting
 * a track that would render an empty menu entry.
 */
export function toWebVtt(source: string): string | null {
  // Strip a UTF-8 BOM. A leading ﻿ before `WEBVTT` makes the whole file
  // invalid, and sidecars written by Windows tooling carry one often enough.
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!TIMING_LINE.test(text)) return null;

  const lines = text.split('\n');
  const alreadyVtt = lines[0]?.trimStart().startsWith('WEBVTT') ?? false;

  const body = lines
    .map((line) =>
      // Only timing lines get the separator swap. A comma inside dialogue is
      // dialogue, and rewriting it would corrupt the caption text.
      TIMING_LINE.test(line)
        ? line.replace(/(\d{2}):(\d{2}):(\d{2}),(\d{1,3})/g, '$1:$2:$3.$4')
        : line,
    )
    .join('\n');

  return alreadyVtt ? body : `WEBVTT\n\n${body}`;
}

/** Subtitle extensions the scanner records as `kind = 'subtitle'`. */
const SUB_EXT = /\.(srt|vtt)$/i;
/** Optional BCP-47-ish tag: `.en`, `.en_US`, `.pt-BR`. */
const LANG_TAG = /\.[a-z]{2}([-_][A-Za-z]{2,4})?$/;
/** Video containers the manifest records as `kind = 'video'`. */
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v)$/i;

/**
 * The stem a video and its subtitle share.
 *
 * Two naming conventions both appear in the library and must collapse to the
 * same key:
 *
 *   lesson.mp4   ->  lesson.srt          lesson.en_US.vtt
 *   lesson.mp4   ->  lesson.mp4.srt      (keeps the video extension)
 *
 * The second is not exotic — it is what `scripts/asr/backfill.py` writes for
 * every video it transcribes, so the entire Whisper backfill lands in that
 * shape. Stripping only the subtitle extension leaves `lesson.mp4`, which never
 * equals `lesson`, so those sidecars pair with nothing. Measured on the real
 * library before this: 2,026 of 3,046 videos in subtitled courses paired; the
 * missing 1,020 were all `<video>.<ext>.srt`.
 *
 * Each strip is anchored and applied once, so `Chapter 1.2 - Intro` keeps the
 * dot in its own name.
 */
export function subtitleStem(relPath: string): string {
  return relPath.replace(SUB_EXT, '').replace(LANG_TAG, '').replace(VIDEO_EXT, '').toLowerCase();
}

/** The stem of a video path — extension off, nothing else. */
export function videoStem(relPath: string): string {
  return relPath.replace(/\.[^./]+$/, '').toLowerCase();
}
