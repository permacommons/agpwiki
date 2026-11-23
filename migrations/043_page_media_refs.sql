CREATE TABLE page_media_refs (
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position > 0),
  media_slug VARCHAR(200) NOT NULL,
  PRIMARY KEY (page_id, language, position),
  UNIQUE (page_id, language, media_slug)
);

CREATE INDEX idx_page_media_refs_media_slug ON page_media_refs (media_slug);

CREATE INDEX idx_pages_current_created_slug ON pages (created_at DESC, slug)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;
