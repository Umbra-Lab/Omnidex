-- Learn R3 substrate: know what is inside a course.
--
-- Learn shipped as a card carrying a folder name and the literal string
-- "tutorial". No duration, no video count, no chapters, no subtitle flag, and
-- clicking it opened Windows Explorer. Everything the screen wants — and
-- everything an AI layer over transcripts would later need — comes from
-- actually enumerating the course folder once and writing it down.
--
-- One row per file that matters. Chapters are derived from `chapter`, which
-- the scanner fills from the folder a video sits in, so no separate table.
CREATE TABLE IF NOT EXISTS course_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL,
    -- Path relative to the course root; the display path and the stable key.
    rel_path TEXT NOT NULL,
    abs_path TEXT NOT NULL,
    -- 'video' | 'subtitle' | 'doc' | 'project'
    kind TEXT NOT NULL,
    -- Immediate parent folder under the course root, or NULL at the root.
    -- This is the chapter a video belongs to.
    chapter TEXT,
    -- Sort key parsed from a leading number in the filename ("03 - Foo" -> 3),
    -- falling back to lexical order. Course folders are numbered, not dated.
    order_index INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    -- Seconds, from the MP4 header. NULL when the container is not MP4 or the
    -- header could not be read — an honest unknown, never a guessed zero.
    duration_seconds REAL,
    UNIQUE (asset_id, rel_path),
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_course_files_asset ON course_files(asset_id, kind);

-- Playback position, per file. One row per file the user has actually opened.
--
-- Resume is the difference between an index and a library, and it is the only
-- signal that says which of these courses you actually care about — which is
-- what makes the "In progress" facet worth having.
CREATE TABLE IF NOT EXISTS course_progress (
    file_id INTEGER PRIMARY KEY,
    position_seconds REAL NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (file_id) REFERENCES course_files(id) ON DELETE CASCADE
);

-- Subtitle text, one row per cue, searchable.
--
-- The stated destination is an AI wiki over transcripts. The unglamorous
-- substrate for that is exactly this: cue text with a timestamp and a file to
-- jump back to. FTS5 so "niagara ribbon" finds the moment someone said it.
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    text,
    file_id UNINDEXED,
    start_ms UNINDEXED,
    tokenize='porter unicode61'
);
