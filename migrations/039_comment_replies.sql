-- A comment either opens a conversation in its thread (no parent) or replies
-- to one of those comments. Replies go one level deep only: a reply's parent
-- must be a top-level comment of the same thread.
ALTER TABLE forum_comments ADD COLUMN parent_id UUID;

CREATE INDEX idx_forum_comments_parent_current
  ON forum_comments (parent_id, created_at)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false AND parent_id IS NOT NULL;

-- A CHECK constraint cannot look at another row, so a trigger enforces the
-- depth. Archived revisions (_old_rev_of set) are copies and are not checked
-- again; a parent that was deleted later still counts as the parent.
CREATE FUNCTION forum_comments_check_parent() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NULL OR NEW._old_rev_of IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1
     FROM forum_comments parent
    WHERE parent.id = NEW.parent_id
      AND parent.id <> NEW.id
      AND parent._old_rev_of IS NULL
      AND parent.thread_id = NEW.thread_id
      AND parent.parent_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A reply must answer a top-level comment of the same thread.'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'forum_comments_parent_check';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER forum_comments_parent_check
  BEFORE INSERT OR UPDATE OF parent_id, thread_id ON forum_comments
  FOR EACH ROW EXECUTE FUNCTION forum_comments_check_parent();
