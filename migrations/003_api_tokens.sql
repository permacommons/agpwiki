CREATE TABLE api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_prefix CHAR(8) NOT NULL,
  label VARCHAR(128),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT api_tokens_label_check CHECK (label IS NULL OR char_length(label) <= 128),
  CONSTRAINT api_tokens_prefix_check CHECK (char_length(token_prefix) = 8),
  CONSTRAINT api_tokens_hash_check CHECK (char_length(token_hash) = 64),
  CONSTRAINT api_tokens_user_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_api_tokens_hash ON api_tokens (token_hash);
CREATE INDEX idx_api_tokens_user ON api_tokens (user_id);
