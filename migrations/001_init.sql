CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(128) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT users_display_name_check CHECK (char_length(display_name) <= 128),
  CONSTRAINT users_email_check CHECK (char_length(email) <= 254)
);

CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(200) NOT NULL,
  title JSONB,
  body JSONB,
  original_language VARCHAR(8),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _rev_summary JSONB,
  _old_rev_of UUID,
  _rev_deleted BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_pages_current ON pages (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_pages_old_rev_of ON pages (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE UNIQUE INDEX idx_pages_slug_current ON pages (slug)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

ALTER TABLE pages
  ADD CONSTRAINT pages_rev_user_fkey
  FOREIGN KEY (_rev_user)
  REFERENCES users(id);
