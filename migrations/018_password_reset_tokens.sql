CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  email VARCHAR(254) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_prefix CHAR(8) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT password_reset_tokens_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT password_reset_tokens_hash_check CHECK (char_length(token_hash) = 64),
  CONSTRAINT password_reset_tokens_prefix_check CHECK (char_length(token_prefix) = 8),
  CONSTRAINT password_reset_tokens_email_check CHECK (char_length(email) <= 254)
);

CREATE UNIQUE INDEX idx_password_reset_tokens_hash
  ON password_reset_tokens (token_hash);

CREATE INDEX idx_password_reset_tokens_user
  ON password_reset_tokens (user_id, created_at DESC);

CREATE INDEX idx_password_reset_tokens_active
  ON password_reset_tokens (user_id, created_at DESC)
  WHERE used_at IS NULL;
