-- Agents ask what changed since a point in time (changes_since), reading
-- each kind of revision oldest first from that point.
CREATE INDEX IF NOT EXISTS pages_rev_date_id_idx ON pages (_rev_date, _rev_id);
CREATE INDEX IF NOT EXISTS citations_rev_date_id_idx ON citations (_rev_date, _rev_id);
CREATE INDEX IF NOT EXISTS citation_claims_rev_date_id_idx ON citation_claims (_rev_date, _rev_id);
CREATE INDEX IF NOT EXISTS media_rev_date_id_idx ON media (_rev_date, _rev_id);
CREATE INDEX IF NOT EXISTS page_checks_rev_date_id_idx ON page_checks (_rev_date, _rev_id);
