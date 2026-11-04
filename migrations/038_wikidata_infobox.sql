-- What infoboxes show from Wikidata, one row per item, refreshed when old.
CREATE TABLE wikidata_items (
  qid TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  fetched_at TIMESTAMP WITH TIME ZONE NOT NULL
);
