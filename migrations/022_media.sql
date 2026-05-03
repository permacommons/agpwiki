CREATE TABLE media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(200) NOT NULL,
  title JSONB,
  commons_title VARCHAR(255) NOT NULL,
  media_type VARCHAR(16) NOT NULL,
  data JSONB NOT NULL,
  caption JSONB,
  alt_text JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _rev_summary JSONB,
  _old_rev_of UUID,
  _rev_deleted BOOLEAN DEFAULT FALSE,

  CONSTRAINT media_slug_check CHECK (char_length(slug) <= 200),
  CONSTRAINT media_commons_title_check CHECK (char_length(commons_title) <= 255),
  CONSTRAINT media_media_type_check CHECK (media_type IN ('image'))
);

CREATE INDEX idx_media_current ON media (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_media_old_rev_of ON media (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE UNIQUE INDEX idx_media_slug_current ON media (slug)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE UNIQUE INDEX idx_media_commons_title_current ON media (commons_title)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

ALTER TABLE media
  ADD CONSTRAINT media_rev_user_fkey
  FOREIGN KEY (_rev_user)
  REFERENCES users(id);
