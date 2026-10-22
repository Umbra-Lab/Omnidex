-- Learn Tab: add content format, completion status, and tutorial source to assets.
-- These columns support the Learn tab's filtering and display.

-- content_format: course, workshop, ebook, reference, bookmark, or NULL (regular asset)
ALTER TABLE assets ADD COLUMN content_format TEXT;

-- completion_status: not_started, in_progress, completed (defaults to not_started)
ALTER TABLE assets ADD COLUMN completion_status TEXT DEFAULT 'not_started';

-- tutorial_source: gnomon, udemy, flippednormals, artstation, cgma, gumroad, youtube, other
ALTER TABLE assets ADD COLUMN tutorial_source TEXT;

-- Index for fast Learn tab queries
CREATE INDEX IF NOT EXISTS idx_assets_content_format ON assets(content_format);
CREATE INDEX IF NOT EXISTS idx_assets_tutorial_source ON assets(tutorial_source);
CREATE INDEX IF NOT EXISTS idx_assets_completion_status ON assets(completion_status);
