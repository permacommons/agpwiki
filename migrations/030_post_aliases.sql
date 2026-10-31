-- Old addresses of renamed blog posts, answered with a redirect to the
-- current address, like page_aliases for wiki pages.
CREATE TABLE post_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id),
  slug VARCHAR(200) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_post_aliases_slug ON post_aliases (slug);
CREATE INDEX idx_post_aliases_post_id ON post_aliases (post_id);
