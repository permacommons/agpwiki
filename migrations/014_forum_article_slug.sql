ALTER TABLE forum_threads
  ADD COLUMN page_slug VARCHAR(200);

CREATE INDEX idx_forum_threads_page_current
  ON forum_threads (page_slug, pinned DESC, created_at DESC)
  WHERE _old_rev_of IS NULL
    AND _rev_deleted = false
    AND category IN ('articles', 'policy')
    AND page_slug IS NOT NULL;
