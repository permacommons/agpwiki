ALTER TABLE api_tokens
  ADD COLUMN token_last4 CHAR(4);

ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_last4_check CHECK (token_last4 IS NULL OR char_length(token_last4) = 4);

CREATE TABLE signup_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash CHAR(64) NOT NULL,
  code_prefix CHAR(8) NOT NULL,
  email VARCHAR(254),
  role VARCHAR(64),
  issued_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  used_at TIMESTAMP WITH TIME ZONE,
  used_by UUID,
  revoked_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT signup_invites_prefix_check CHECK (char_length(code_prefix) = 8),
  CONSTRAINT signup_invites_hash_check CHECK (char_length(code_hash) = 64),
  CONSTRAINT signup_invites_email_check CHECK (email IS NULL OR char_length(email) <= 254),
  CONSTRAINT signup_invites_role_check CHECK (role IS NULL OR char_length(role) <= 64),
  CONSTRAINT signup_invites_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES users(id),
  CONSTRAINT signup_invites_used_by_fkey FOREIGN KEY (used_by) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_signup_invites_hash ON signup_invites (code_hash);
CREATE INDEX idx_signup_invites_prefix ON signup_invites (code_prefix);
CREATE INDEX idx_signup_invites_used ON signup_invites (used_at);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_prefix CHAR(8) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT auth_sessions_prefix_check CHECK (char_length(token_prefix) = 8),
  CONSTRAINT auth_sessions_hash_check CHECK (char_length(token_hash) = 64),
  CONSTRAINT auth_sessions_user_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_auth_sessions_hash ON auth_sessions (token_hash);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);
