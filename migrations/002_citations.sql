CREATE TABLE citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(200) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _rev_summary JSONB,
  _old_rev_of UUID,
  _rev_deleted BOOLEAN DEFAULT FALSE,

  CONSTRAINT citations_key_check CHECK (char_length(key) <= 200)
);

CREATE INDEX idx_citations_current ON citations (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_citations_old_rev_of ON citations (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE UNIQUE INDEX idx_citations_key_current ON citations (key)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

ALTER TABLE citations
  ADD CONSTRAINT citations_rev_user_fkey
  FOREIGN KEY (_rev_user)
  REFERENCES users(id);
