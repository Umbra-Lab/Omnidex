/**
 * The stem a video and its subtitle sidecar share.
 *
 * Renderer copy of `electron/main/scanner/subtitles.ts` — the renderer cannot
 * import main-process modules, and this pairing rule must match the one the
 * scanner and `has_subtitle` use or the two surfaces disagree about which
 * lessons have captions. Keep the regexes in sync with that file.
 *
 * Conventions that must collapse to one key:
 *   lesson.mp4  ->  lesson.srt        lesson.en_US.vtt
 *   lesson.mp4  ->  lesson.mp4.srt    (the Whisper backfill's shape)
 */

const SUB_EXT = /\.(srt|vtt)$/i;
const LANG_TAG = /\.[a-z]{2}([-_][A-Za-z]{2,4})?$/;
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v)$/i;

export function subtitleStem(relPath: string): string {
  return relPath.replace(SUB_EXT, '').replace(LANG_TAG, '').replace(VIDEO_EXT, '').toLowerCase();
}

export function videoStem(relPath: string): string {
  return relPath.replace(/\.[^./]+$/, '').toLowerCase();
}
