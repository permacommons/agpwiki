-- Position comments no longer have a length limit.
ALTER TABLE page_signoffs DROP CONSTRAINT page_signoffs_comment_check;

-- A forum thread can be attached to something other than a page, so one
-- comment system serves every place where people reply. The first use:
-- replies to a position on a proposal (attached_type 'position', the
-- position's ID).
ALTER TABLE forum_threads
  ADD COLUMN attached_type VARCHAR(32),
  ADD COLUMN attached_id UUID;

CREATE INDEX idx_forum_threads_attachment
  ON forum_threads (attached_type, attached_id)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;
