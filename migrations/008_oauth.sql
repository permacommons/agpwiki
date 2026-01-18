CREATE TABLE oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id VARCHAR(128) NOT NULL,
  client_secret_hash CHAR(64),
  client_secret_prefix CHAR(8),
  client_secret_last4 CHAR(4),
  client_name VARCHAR(128),
  redirect_uris TEXT[] NOT NULL,
  grant_types TEXT[] NOT NULL,
  token_endpoint_auth_method VARCHAR(32) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  revoked_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT oauth_clients_id_unique UNIQUE (client_id),
  CONSTRAINT oauth_clients_secret_prefix_check CHECK (
    client_secret_prefix IS NULL OR char_length(client_secret_prefix) = 8
  ),
  CONSTRAINT oauth_clients_secret_hash_check CHECK (
    client_secret_hash IS NULL OR char_length(client_secret_hash) = 64
  ),
  CONSTRAINT oauth_clients_secret_last4_check CHECK (
    client_secret_last4 IS NULL OR char_length(client_secret_last4) = 4
  )
);

CREATE TABLE oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash CHAR(64) NOT NULL,
  code_prefix CHAR(8) NOT NULL,
  client_id VARCHAR(128) NOT NULL,
  user_id UUID NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method VARCHAR(16) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  consumed_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT oauth_auth_codes_hash_check CHECK (char_length(code_hash) = 64),
  CONSTRAINT oauth_auth_codes_prefix_check CHECK (char_length(code_prefix) = 8),
  CONSTRAINT oauth_auth_codes_client_fkey FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id),
  CONSTRAINT oauth_auth_codes_user_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_oauth_auth_codes_hash ON oauth_authorization_codes (code_hash);
CREATE INDEX idx_oauth_auth_codes_client ON oauth_authorization_codes (client_id);
CREATE INDEX idx_oauth_auth_codes_user ON oauth_authorization_codes (user_id);
CREATE INDEX idx_oauth_auth_codes_expires ON oauth_authorization_codes (expires_at);

CREATE TABLE oauth_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash CHAR(64) NOT NULL,
  token_prefix CHAR(8) NOT NULL,
  token_last4 CHAR(4),
  client_id VARCHAR(128) NOT NULL,
  user_id UUID NOT NULL,
  scopes TEXT[] NOT NULL,
  issued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_used_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT oauth_access_tokens_hash_check CHECK (char_length(token_hash) = 64),
  CONSTRAINT oauth_access_tokens_prefix_check CHECK (char_length(token_prefix) = 8),
  CONSTRAINT oauth_access_tokens_last4_check CHECK (token_last4 IS NULL OR char_length(token_last4) = 4),
  CONSTRAINT oauth_access_tokens_client_fkey FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id),
  CONSTRAINT oauth_access_tokens_user_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_oauth_access_tokens_hash ON oauth_access_tokens (token_hash);
CREATE INDEX idx_oauth_access_tokens_user ON oauth_access_tokens (user_id);
CREATE INDEX idx_oauth_access_tokens_expires ON oauth_access_tokens (expires_at);

CREATE TABLE oauth_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash CHAR(64) NOT NULL,
  token_prefix CHAR(8) NOT NULL,
  token_last4 CHAR(4),
  client_id VARCHAR(128) NOT NULL,
  user_id UUID NOT NULL,
  scopes TEXT[] NOT NULL,
  issued_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  rotated_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT oauth_refresh_tokens_hash_check CHECK (char_length(token_hash) = 64),
  CONSTRAINT oauth_refresh_tokens_prefix_check CHECK (char_length(token_prefix) = 8),
  CONSTRAINT oauth_refresh_tokens_last4_check CHECK (token_last4 IS NULL OR char_length(token_last4) = 4),
  CONSTRAINT oauth_refresh_tokens_client_fkey FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id),
  CONSTRAINT oauth_refresh_tokens_user_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_oauth_refresh_tokens_hash ON oauth_refresh_tokens (token_hash);
CREATE INDEX idx_oauth_refresh_tokens_user ON oauth_refresh_tokens (user_id);
CREATE INDEX idx_oauth_refresh_tokens_expires ON oauth_refresh_tokens (expires_at);
