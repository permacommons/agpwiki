CREATE TABLE forum_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(32) NOT NULL,
  title JSONB NOT NULL,
  original_language VARCHAR(8),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _rev_summary JSONB,
  _old_rev_of UUID,
  _rev_deleted BOOLEAN DEFAULT FALSE,

  CONSTRAINT forum_threads_category_check CHECK (char_length(category) <= 32),
  CONSTRAINT forum_threads_title_check CHECK (jsonb_typeof(title) = 'object')
);

CREATE INDEX idx_forum_threads_current ON forum_threads (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_forum_threads_old_rev_of ON forum_threads (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE INDEX idx_forum_threads_category_current ON forum_threads (category, pinned DESC, created_at DESC)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

ALTER TABLE forum_threads
  ADD CONSTRAINT forum_threads_rev_user_fkey
  FOREIGN KEY (_rev_user)
  REFERENCES users(id);

CREATE TABLE forum_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL,
  body JSONB NOT NULL,
  original_language VARCHAR(8),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  _rev_id UUID NOT NULL,
  _rev_user UUID,
  _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
  _rev_tags TEXT[],
  _rev_summary JSONB,
  _old_rev_of UUID,
  _rev_deleted BOOLEAN DEFAULT FALSE,

  CONSTRAINT forum_comments_thread_fkey FOREIGN KEY (thread_id) REFERENCES forum_threads(id)
);

CREATE INDEX idx_forum_comments_current ON forum_comments (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX idx_forum_comments_old_rev_of ON forum_comments (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE INDEX idx_forum_comments_thread_current ON forum_comments (thread_id, created_at)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

ALTER TABLE forum_comments
  ADD CONSTRAINT forum_comments_rev_user_fkey
  FOREIGN KEY (_rev_user)
  REFERENCES users(id);
