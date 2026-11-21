-- An Assets/ folder with no ProjectSettings/ beside it (a course chapter's materials, or
-- an Assets/ copied out on its own) is indexed like a project. These say which it is.

-- 1 for an Assets/ folder without project settings of its own.
ALTER TABLE unity_projects ADD COLUMN assets_only INTEGER NOT NULL DEFAULT 0;
-- The enclosing project whose Editor version and packages it was given, if any.
ALTER TABLE unity_projects ADD COLUMN settings_from TEXT;
