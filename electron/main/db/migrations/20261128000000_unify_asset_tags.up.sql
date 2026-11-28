-- Make asset_tags the one tag store again, and rebuild the assets.tags mirror
-- from it.
--
-- The FAB sync wrote its category slugs straight into assets.tags. That
-- dropped every user tag on a synced pack from search, the tag filter and the
-- card (the asset_tags rows were still there), and the next tag edit on that
-- pack rebuilt the mirror from the rows and dropped the FAB tags instead.
-- Older libraries can also have tags in the mirror with no row behind them.
-- The app now writes FAB tags as rows (source 'official'); this repairs data
-- written before that.

-- 1. A tag that is in the mirror but has no row gets one, so the next edit
--    keeps it. The nested CASE keeps json_each away from a mirror that is not
--    a JSON array (json_each and json_type both raise on malformed JSON).
INSERT OR IGNORE INTO asset_tags (asset_id, tag, tag_type, confidence, source)
SELECT a.id, trim(j.value), 'technical', NULL, 'official'
FROM assets a,
     json_each(
       COALESCE(
         CASE WHEN json_valid(a.tags) THEN
           CASE WHEN json_type(a.tags) = 'array' THEN a.tags END
         END,
         '[]'
       )
     ) j
WHERE a.tags IS NOT NULL
  AND j.type = 'text'
  AND trim(j.value) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = trim(j.value)
  );

-- 2. Rebuild the mirror from the rows, in row order, as the app does
--    (tagMirrorWriter). Only rows whose mirror changes are written, so the
--    assets_fts_au trigger reindexes just those. A mirror that is not valid
--    JSON is left alone: nothing in the app could have written it, and
--    rewriting it would lose whatever it holds.
UPDATE assets
SET tags = (
  SELECT json_group_array(tag) FROM (
    SELECT tag FROM asset_tags t WHERE t.asset_id = assets.id GROUP BY tag ORDER BY MIN(t.id)
  )
)
WHERE id IN (SELECT asset_id FROM asset_tags)
  AND (tags IS NULL OR json_valid(tags))
  AND tags IS NOT (
    SELECT json_group_array(tag) FROM (
      SELECT tag FROM asset_tags t WHERE t.asset_id = assets.id GROUP BY tag ORDER BY MIN(t.id)
    )
  );
