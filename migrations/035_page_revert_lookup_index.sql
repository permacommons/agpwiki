CREATE INDEX IF NOT EXISTS pages_revert_page_date_idx
  ON pages (COALESCE(_old_rev_of, id), _rev_date)
  WHERE 'revert' = ANY(_rev_tags);
