CREATE TABLE page_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL,
  type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  check_results JSONB NOT NULL,
  notes JSONB,
  metrics JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  target_rev_id UUID NOT NULL,

  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _rev_summary JSONB,
  _old_rev_of UUID,
  _rev_deleted BOOLEAN DEFAULT FALSE,

  CONSTRAINT page_checks_type_check CHECK (char_length(type) <= 64),
  CONSTRAINT page_checks_status_check CHECK (char_length(status) <= 32),
  CONSTRAINT page_checks_page_fkey FOREIGN KEY (page_id) REFERENCES pages(id)
);

CREATE INDEX idx_page_checks_current ON page_checks (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_page_checks_old_rev_of ON page_checks (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE INDEX idx_page_checks_page_current ON page_checks (page_id)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

ALTER TABLE page_checks
  ADD CONSTRAINT page_checks_rev_user_fkey
  FOREIGN KEY (_rev_user)
  REFERENCES users(id);
