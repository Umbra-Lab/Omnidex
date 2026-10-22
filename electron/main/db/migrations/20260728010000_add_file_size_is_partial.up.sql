-- `file_size` is a lower bound whenever the scanner's per-pack walk hit
-- MAX_FILES_PER_PACK / MAX_DEPTH_PER_PACK (see electron/main/scanner/walker.ts).
-- Measured on the user's real library, 29 of 1,256 packs exceed the file cap
-- and together under-report 247.6 GB. This flag lets the inspector render
-- "26.7 GB+" instead of a precise number that is known to be wrong.
--
-- Defaults to 0: rows written before this migration were not measured for
-- truncation, and the next scan overwrites the flag with the real value.
ALTER TABLE assets ADD COLUMN file_size_is_partial INTEGER NOT NULL DEFAULT 0;
