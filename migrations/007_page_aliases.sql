CREATE TABLE page_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL,
  slug VARCHAR(200) NOT NULL,
  lang VARCHAR(8),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID
);

CREATE UNIQUE INDEX idx_page_aliases_slug ON page_aliases (slug);
CREATE INDEX idx_page_aliases_page_id ON page_aliases (page_id);

ALTER TABLE page_aliases
  ADD CONSTRAINT page_aliases_page_id_fkey
  FOREIGN KEY (page_id)
  REFERENCES pages(id);

ALTER TABLE page_aliases
  ADD CONSTRAINT page_aliases_created_by_fkey
  FOREIGN KEY (created_by)
  REFERENCES users(id);
