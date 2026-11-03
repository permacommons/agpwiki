-- People who follow the comments on a page: new discussion threads about it,
-- comments in those threads, and positions on proposals. Edits do not
-- notify. Keyed by the page's stable id, so following survives renames.
CREATE TABLE page_subscriptions (
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscribed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (page_id, user_id)
);

CREATE INDEX idx_page_subscriptions_user ON page_subscriptions (user_id, subscribed_at);

-- Whoever created a page follows it. For existing pages that is the author
-- of the first revision; imported revisions without an author are skipped.
INSERT INTO page_subscriptions (page_id, user_id, subscribed_at)
SELECT first_revision.page_id, first_revision.user_id, NOW()
  FROM (
    SELECT DISTINCT ON (p.id) p.id AS page_id, r._rev_user AS user_id
      FROM pages p
      JOIN pages r ON (r.id = p.id OR r._old_rev_of = p.id)
     WHERE p._old_rev_of IS NULL
       AND p._rev_deleted = false
     ORDER BY p.id, r._rev_date ASC
  ) first_revision
  JOIN users u ON u.id = first_revision.user_id
ON CONFLICT DO NOTHING;
