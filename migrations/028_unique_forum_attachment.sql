CREATE UNIQUE INDEX uq_forum_threads_current_attachment
  ON forum_threads (attached_type, attached_id)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

DROP INDEX idx_forum_threads_attachment;
