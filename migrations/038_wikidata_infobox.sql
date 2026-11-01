-- What infoboxes show from Wikidata, one row per item, refreshed when old.
CREATE TABLE wikidata_items (
  qid TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  fetched_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Values added on Agpedia that differ from Wikidata's value for the same
-- property, kept so they can be listed and checked. A row goes away when the
-- two agree again or the Agpedia value is removed.
CREATE TABLE infobox_mismatches (
  page_id UUID NOT NULL,
  property TEXT NOT NULL,
  qid TEXT NOT NULL,
  agpedia_value TEXT NOT NULL,
  wikidata_value TEXT NOT NULL,
  detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (page_id, property)
);
