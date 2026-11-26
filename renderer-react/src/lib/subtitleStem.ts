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
const LANG_TAG = /\.[a-z]{2}([-_][a-z]{2,4})?$/i;
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v)$/i;

export function subtitleStem(relPath: string): string {
  return relPath.replace(SUB_EXT, '').replace(LANG_TAG, '').replace(VIDEO_EXT, '').toLowerCase();
}

export function videoStem(relPath: string): string {
  return relPath.replace(/\.[^./]+$/, '').toLowerCase();
}

/**
 * Whether a subtitle sidecar belongs to a video.
 *
 * The language-tag strip cannot tell `Lesson.EN.srt` (English captions for
 * `Lesson.mp4`) from `Intro.UE.srt` (plain captions for `Intro.UE.mp4`): both
 * end in a two-letter word. So the sidecar pairs when either its tag-stripped
 * or its unstripped stem equals the video's.
 */
export function subtitlePairsWith(subtitlePath: string, videoPath: string): boolean {
  const wanted = videoStem(videoPath);
  return subtitleStem(subtitlePath) === wanted || untaggedStem(subtitlePath) === wanted;
}

/** `subtitleStem` without the language-tag strip. */
function untaggedStem(relPath: string): string {
  return relPath.replace(SUB_EXT, '').replace(VIDEO_EXT, '').toLowerCase();
}
