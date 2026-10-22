# What Omnidex is

Omnidex indexes media libraries that have grown past the point where a file browser helps. It handles two kinds of content today — Unreal Engine asset packs and video courses — and turns a few terabytes of nested folders into a catalogue you can search, filter, tag, and play from.

It is local-first in the strict sense: the database is a SQLite file on your disk, the thumbnails are PNGs on your disk, and the app works with the network unplugged. Two features reach outward, both optional and both explicitly triggered — marketplace metadata lookup and Epic FAB library sync.

```admonish info title="Who this page is for"
Read this before touching the code. It defines the problem, the vocabulary the rest of the book uses, and the constraints that explain why the architecture looks the way it does. It does not explain how any of it is built — [How it works](architecture.md) does that.
```

## The problem

A working library of bought and downloaded assets has properties that defeat ordinary tools:

- **It is large.** A real library runs to thousands of packs and tens of thousands of video files across multiple drives. A representative install indexes roughly 2,800 asset packs and 284 courses containing about 25,800 videos.
- **The folder names are the only metadata.** A pack arrives as `8155328/Winfox - Unreal Engine5 Procedural Environment Production Pipeline/`. Nothing inside says what it is, who made it, what it costs, or whether you already own something similar.
- **It is scattered and duplicated.** The same pack exists under three different vendor spellings, in a "sorted" folder and an "unsorted" one, on two drives.
- **The valuable part is not searchable at all.** A ten-hour course contains the answer to a specific question at 04:12 of lesson 31. Nothing indexes that.

The last point is the one that matters most, and it is where Omnidex spends its effort. Filenames are a weak index of a video library because instructors do not say their own lesson titles out loud, and lesson titles do not describe what is demonstrated inside them. Transcripts are the real index.

## What it does

**Scanning** walks a configured folder and registers what it finds. A folder is treated either as an *asset pack* or as a *course*, decided by the scan location's `content_format`, not by guessing per folder.

**Thumbnails** come from a `.uasset` file's embedded preview where one exists, and otherwise from a hero image shipped in the pack.

**Enrichment** matches a local pack against a marketplace listing to fill in title, seller, category, price, and rating.

**Learn** is the course side: a manifest of lessons per course, playback position, completion, subtitle tracks, and full-text search across every transcript cue in the library.

**The oracle** exposes the transcript index over MCP, so an AI assistant can search what your courses actually say and cite a timestamp.

## Vocabulary

These terms mean one specific thing throughout the codebase and this book.

| Term | Meaning |
|---|---|
| **Scan location** | A configured root folder. Called a "folder" in the UI, `scan_location` in code and the database. |
| **Asset** | One row in `assets`. Either a pack or a course — `content_format` distinguishes them. |
| **Pack** | An asset with `content_format IS NULL`. A bought or downloaded bundle of files. |
| **Course** | An asset with `content_format = 'course'`. Has rows in `course_files`. |
| **Lesson** | One video inside a course; a `course_files` row with `kind = 'video'`. |
| **Cue** | One timed line of subtitle text, in `transcript_cues`. The unit transcript search returns. |
| **Ecosystem** | Which tool a pack targets (Unreal, Blender, Houdini, and so on). |
| **Enrichment** | Attaching marketplace metadata to a local pack. |

```admonish warning title="Folder vs scan location"
User-facing copy says "folder". Code and schema say `scan_location`. Do not mix them — a UI string reading `scan_location` is a bug, and so is a column named `folder`.
```

## Constraints that shape the design

Three constraints explain most of the architecture, and they are worth holding in mind before proposing a change.

**The library does not fit in memory, and scans are long.** A full scan crosses several terabytes and takes minutes to hours. Anything on that path must be resumable, must not hold the whole result set, and must survive a component failing partway. Work that can fail is isolated from work that must complete.

**SQLite is synchronous and single-writer.** `better-sqlite3` blocks the thread it runs on. Long operations belong in the main process, never in a request handler that the UI is waiting on, and writes are batched into transactions rather than committed per row.

**The renderer is untrusted with the filesystem.** It never opens a file path directly. Local media reaches it through the `omnidex-asset://` protocol handler, which is the single place path access is validated.

## Next steps

- [How it works](architecture.md) — the processes, the boundaries, and what talks to what
- [The data model](data-model.md) — how assets, courses, and cues relate
