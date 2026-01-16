CREATE TABLE user_roles (
  user_id UUID NOT NULL,
  role VARCHAR(64) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT user_roles_user_fkey FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT user_roles_role_check CHECK (char_length(role) <= 64),
  CONSTRAINT user_roles_unique UNIQUE (user_id, role)
);

CREATE INDEX idx_user_roles_role ON user_roles (role);

CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(200) NOT NULL,
  title JSONB,
  body JSONB,
  summary JSONB,
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

CREATE INDEX idx_posts_current ON posts (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_posts_old_rev_of ON posts (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE UNIQUE INDEX idx_posts_slug_current ON posts (slug)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

ALTER TABLE posts
  ADD CONSTRAINT posts_rev_user_fkey
  FOREIGN KEY (_rev_user)
  REFERENCES users(id);
