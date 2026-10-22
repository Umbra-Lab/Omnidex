# Learn: courses and transcripts

Learn is the course half of Omnidex: a manifest of lessons per course, playback position, subtitle tracks, and full-text search across every cue in the library.

Its central claim is that **transcripts are the real index of a video library**. Filenames are a weak one, because instructors do not say their own lesson titles out loud and lesson titles do not describe what is demonstrated inside them. Both indexes exist because they fail in opposite directions.

## The manifest

A course asset gets one `course_files` row per file that matters:

| `kind` | What it is |
|---|---|
| `video` | A lesson |
| `subtitle` | An `.srt` or `.vtt` sidecar |
| `doc` | A PDF or readme shipped with the course |

`chapter` and `order_index` come from the folder layout and the author's numbering. Ordering is numeric-aware, so lessons sort `1, 2, 10` rather than `1, 10, 2`.

Built by `buildCourseManifest` in `electron/main/scanner/course-manifest.ts`, walking to depth 6.

## Pairing subtitles to videos

A subtitle belongs to a video when their **stems** match. `electron/main/scanner/subtitles.ts` normalises both:

```ts
const SUB_EXT = /\.(srt|vtt)$/i;
const LANG_TAG = /\.[a-z]{2}([-_][A-Za-z]{2,4})?$/;
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v)$/i;
```

Strip the subtitle extension, then a language tag, then a video extension. That last step is what makes `lesson.mp4.srt` — the shape ASR tools write — pair with `lesson.mp4`.

```admonish warning title="Stem matching must not be greedy"
`Lesson 10.srt` must not claim `Lesson 1.mp4`. Matching is on the full normalised stem, never a prefix. `electron/main/scanner/__tests__/subtitles.test.ts` pins this.
```

Pairing is also scoped to the course. Two courses can each contain `01 - Intro.mp4`, and a global stem match would hand back the wrong lesson's captions.

### When a lesson has two subtitle files

A foreign-language lesson can carry both its native `X.srt` and a translated `X.en.srt`. `subtitlePathForVideo` prefers the English-tagged one explicitly. Picking the first match would return whichever row the database happened to yield — which, for a Russian course, means it keeps showing Russian after the translation ran.

## Serving captions

`.srt` and WebVTT differ only in a header line and `,` versus `.` as the millisecond separator, so `toWebVtt()` converts on the fly. The renderer mounts the result as a real `<track>` element rather than rendering cues itself.

## Playback and progress

`course_progress` stores `position_seconds` and `completed` per file id.

```admonish note title="Progress survives a re-scan"
Re-scanning deletes and reinserts `course_files` rows, reassigning their ids. The scanner carries progress across by `rel_path`. This is covered by a test precisely because the id churn makes it easy to break silently.
```

Seeking requires the `omnidex-asset://` handler to answer range requests with `206 Partial Content`. Without it Chromium reports `seekedTo: 0` and resume does not work.

## Containers Chromium will not play

Some course video ships as MPEG-2 Transport Stream, usually with a `.ts` extension. Chromium will not play it.

Detection is by content, not extension: `isMpegTs()` reads 189 bytes and checks for the 0x47 sync byte at offsets 0 and 188. A `.ts` file that is actually TypeScript is not a video.

The player says the container is unplayable rather than showing a dead element. To convert:

```bash
pnpm remux
```

`scripts/remux-unplayable.mjs` stream-copies to MP4 (`-c copy -movflags +faststart -f mp4`) — no re-encode, so it is fast and lossless. It writes to a `.partial` file and renames atomically, verifies duration with ffprobe, is resume-safe, and never deletes the original.

Once a remuxed `.mp4` exists, the manifest builder prefers it and drops the `.ts` sibling from the manifest.

## Transcript search

Full-text search across every cue, ranked by BM25:

```sql
SELECT c.text, c.file_id, c.start_ms
FROM transcript_fts t
JOIN transcript_cues c ON c.id = t.rowid
JOIN course_files f ON f.id = c.file_id
WHERE transcript_fts MATCH ?
ORDER BY rank
LIMIT ?
```

User input is sanitised per token — each token is quoted and given a trailing `*` — so a stray quote or colon is a search term rather than an FTS operator.

Exposed as `courses.searchTranscripts` over tRPC and as `search_transcripts` over MCP.

## Generating missing transcripts

Courses without subtitles get them from Whisper. `scripts/asr/backfill.py` transcribes any video with no subtitle sibling and writes a standard `<video>.srt` next to it, which the scanner then ingests like any shipped subtitle.

Foreign-language lessons additionally get `<video>.en.srt` from Whisper's own `task='translate'`, which produces English **from the source audio** rather than translating the transcript. That avoids compounding a transcription error with a translation error, and needs no second model.

See [Transcribe and translate a course](../guides/transcribe-a-course.md).

## Next steps

- [Transcribe and translate a course](../guides/transcribe-a-course.md) — running the ASR pipeline
- [The oracle MCP server](oracle-mcp.md) — exposing all this to an assistant
- [The data model](../orientation/data-model.md) — how cues relate to lessons
