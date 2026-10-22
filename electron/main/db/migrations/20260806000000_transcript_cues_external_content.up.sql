-- Move subtitle cues into a real table and demote transcript_fts to an FTS5
-- external-content index over it.
--
-- The old shape stored file_id and start_ms as UNINDEXED FTS5 columns, so every
-- non-MATCH filter was a full scan of the whole corpus. Three hot paths did
-- exactly that: get_context (~1.1 s per call at 4.6M cues), the Ask layer's
-- `file_id IN (...)` gather, and `DELETE FROM transcript_fts WHERE file_id = ?`
-- — which runs once per lesson on every re-scan.
--
-- A virtual table also cannot carry a foreign key, so nothing ever reclaimed the
-- cues of a deleted lesson. replaceCourseManifest deletes and reinserts
-- course_files rows, which reassigns their AUTOINCREMENT ids, so every scan
-- stranded the previous scan's cues: 2,794,345 of 4,648,463 rows (60%) belonged
-- to 18,078 file_ids that no longer exist. Those orphans are dropped here — they
-- also skewed BM25, whose IDF is computed over the whole corpus, so ranking was
-- being scored against a corpus that was mostly stale duplicates.
--
-- One-time cost on a 4.6M-cue library: roughly 25 s.

CREATE TABLE transcript_cues (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES course_files (id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  text TEXT NOT NULL
);

-- Only cues whose lesson still exists; the FK above would reject the rest anyway.
INSERT INTO transcript_cues (id, file_id, start_ms, text)
SELECT t.rowid, t.file_id, t.start_ms, t.text
FROM transcript_fts t
WHERE EXISTS (SELECT 1 FROM course_files f WHERE f.id = t.file_id);

CREATE INDEX transcript_cues_file ON transcript_cues (file_id, start_ms);

DROP TABLE transcript_fts;

CREATE VIRTUAL TABLE transcript_fts USING fts5 (
  text,
  content = 'transcript_cues',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

-- Built before the triggers exist, so the bulk load does not fire them.
INSERT INTO transcript_fts (transcript_fts) VALUES ('rebuild');

-- From here the index tracks the table, including the ON DELETE CASCADE above:
-- pruning a lesson now reclaims its cues instead of stranding them.
CREATE TRIGGER transcript_cues_ai AFTER INSERT ON transcript_cues BEGIN
  INSERT INTO transcript_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER transcript_cues_ad AFTER DELETE ON transcript_cues BEGIN
  INSERT INTO transcript_fts (transcript_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER transcript_cues_au AFTER UPDATE ON transcript_cues BEGIN
  INSERT INTO transcript_fts (transcript_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO transcript_fts (rowid, text) VALUES (new.id, new.text);
END;
