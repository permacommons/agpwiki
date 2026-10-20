-- Position comments no longer have a length limit, like forum posts.
ALTER TABLE page_signoffs DROP CONSTRAINT page_signoffs_comment_check;

-- Replies under a position's comment, one level deep.
CREATE TABLE page_signoff_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signoff_id UUID NOT NULL,
  page_id UUID NOT NULL,
  user_id UUID NOT NULL,
  body TEXT NOT NULL,
  body_language VARCHAR(8) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE,
  deleted_at TIMESTAMP WITH TIME ZONE,
  hidden_at TIMESTAMP WITH TIME ZONE,
  hidden_by UUID,

  CONSTRAINT page_signoff_replies_signoff_fkey FOREIGN KEY (signoff_id) REFERENCES page_signoffs(id) ON DELETE CASCADE,
  CONSTRAINT page_signoff_replies_page_fkey FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT page_signoff_replies_user_fkey FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT page_signoff_replies_hidden_by_fkey FOREIGN KEY (hidden_by) REFERENCES users(id)
);

CREATE INDEX idx_page_signoff_replies_signoff ON page_signoff_replies (signoff_id, created_at);
