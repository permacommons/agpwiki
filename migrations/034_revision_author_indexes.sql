-- Whether an editor is experienced is computed on demand from their own
-- revisions in these tables, by author and date.
CREATE INDEX IF NOT EXISTS pages_rev_user_date_idx ON pages (_rev_user, _rev_date);
CREATE INDEX IF NOT EXISTS citations_rev_user_date_idx ON citations (_rev_user, _rev_date);
CREATE INDEX IF NOT EXISTS citation_claims_rev_user_date_idx ON citation_claims (_rev_user, _rev_date);
CREATE INDEX IF NOT EXISTS page_checks_rev_user_date_idx ON page_checks (_rev_user, _rev_date);
