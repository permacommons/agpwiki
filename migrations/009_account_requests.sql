CREATE TABLE account_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(254) NOT NULL,
  topics TEXT NOT NULL,
  portfolio TEXT NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at TIMESTAMP WITH TIME ZONE,
  deleted_by UUID REFERENCES users(id)
);

CREATE INDEX idx_account_requests_created ON account_requests (created_at DESC);
CREATE INDEX idx_account_requests_pending ON account_requests (created_at DESC)
  WHERE deleted_at IS NULL;
