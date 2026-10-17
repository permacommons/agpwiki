CREATE TABLE page_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL,
  rev_id UUID NOT NULL,
  user_id UUID NOT NULL,
  stance VARCHAR(16) NOT NULL,
  comment TEXT,
  signed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT page_signoffs_page_fkey FOREIGN KEY (page_id) REFERENCES pages(id),
  CONSTRAINT page_signoffs_user_fkey FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT page_signoffs_stance_check CHECK (stance IN ('support', 'neutral', 'oppose')),
  CONSTRAINT page_signoffs_comment_check CHECK (char_length(comment) <= 2000)
);

CREATE UNIQUE INDEX idx_page_signoffs_active
  ON page_signoffs (page_id, user_id)
  WHERE withdrawn_at IS NULL;

CREATE INDEX idx_page_signoffs_page ON page_signoffs (page_id, signed_at);
