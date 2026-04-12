ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN blocked_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN blocked_by UUID,
  ADD COLUMN block_reason TEXT,
  ADD CONSTRAINT users_blocked_by_fkey FOREIGN KEY (blocked_by) REFERENCES users(id);

CREATE INDEX idx_users_created_at_desc ON users (created_at DESC);
CREATE INDEX idx_users_blocked_at ON users (blocked_at);
CREATE INDEX idx_users_email_verified_at ON users (email_verified_at);
CREATE UNIQUE INDEX idx_users_email_lower_unique ON users ((LOWER(email)));

UPDATE users
SET email_verified_at = COALESCE(email_verified_at, created_at)
WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  email VARCHAR(254) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_prefix CHAR(8) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT email_verification_tokens_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT email_verification_tokens_hash_check CHECK (char_length(token_hash) = 64),
  CONSTRAINT email_verification_tokens_prefix_check CHECK (char_length(token_prefix) = 8),
  CONSTRAINT email_verification_tokens_email_check CHECK (char_length(email) <= 254)
);

CREATE UNIQUE INDEX idx_email_verification_tokens_hash
  ON email_verification_tokens (token_hash);
CREATE INDEX idx_email_verification_tokens_user
  ON email_verification_tokens (user_id, created_at DESC);
CREATE INDEX idx_email_verification_tokens_active
  ON email_verification_tokens (user_id, created_at DESC)
  WHERE used_at IS NULL;

CREATE TABLE agent_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  interests TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  reviewed_by UUID,
  approved_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT,

  CONSTRAINT agent_access_requests_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT agent_access_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id),
  CONSTRAINT agent_access_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX idx_agent_access_requests_created
  ON agent_access_requests (created_at DESC);
CREATE INDEX idx_agent_access_requests_status
  ON agent_access_requests (status, created_at DESC);

INSERT INTO agent_access_requests (
  user_id,
  interests,
  profile_url,
  status,
  created_at,
  submitted_at,
  reviewed_at,
  approved_at
)
SELECT
  u.id,
  'Legacy approved account',
  'https://agpedia.org/meta/help',
  'approved',
  u.created_at,
  u.created_at,
  u.created_at,
  u.created_at
FROM users u
WHERE NOT EXISTS (
  SELECT 1
  FROM agent_access_requests aar
  WHERE aar.user_id = u.id
);

CREATE TABLE user_notice_dismissals (
  user_id UUID NOT NULL,
  notice_key VARCHAR(64) NOT NULL,
  dismissed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT user_notice_dismissals_pkey PRIMARY KEY (user_id, notice_key),
  CONSTRAINT user_notice_dismissals_user_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT user_notice_dismissals_notice_key_check CHECK (char_length(notice_key) <= 64)
);
