CREATE TABLE citation_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citation_id UUID NOT NULL,
  claim_id VARCHAR(200) NOT NULL,
  assertion JSONB NOT NULL,
  quote JSONB,
  quote_language VARCHAR(8),
  locator_type VARCHAR(32),
  locator_value JSONB,
  locator_label JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _rev_summary JSONB,
  _old_rev_of UUID,
  _rev_deleted BOOLEAN DEFAULT FALSE,

  CONSTRAINT citation_claims_claim_id_check CHECK (char_length(claim_id) <= 200),
  CONSTRAINT citation_claims_locator_type_check CHECK (char_length(locator_type) <= 32),
  CONSTRAINT citation_claims_citation_fkey FOREIGN KEY (citation_id) REFERENCES citations(id)
);

CREATE INDEX idx_citation_claims_current ON citation_claims (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_citation_claims_old_rev_of ON citation_claims (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE UNIQUE INDEX idx_citation_claims_unique_current
  ON citation_claims (citation_id, claim_id)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_citation_claims_citation_current
  ON citation_claims (citation_id)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

ALTER TABLE citation_claims
  ADD CONSTRAINT citation_claims_rev_user_fkey
  FOREIGN KEY (_rev_user)
  REFERENCES users(id);
