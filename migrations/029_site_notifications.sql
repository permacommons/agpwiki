-- The public dump script builds temporary views in this schema and drops it
-- when done. Drop any leftover so its users view does not block the column
-- change below; the script recreates it on the next dump.
DROP SCHEMA IF EXISTS dump_public_export CASCADE;

-- How each person wants each kind of notification: 'both' (email and on
-- site), 'site', 'email' or 'none'. Kinds left out use 'both'.
ALTER TABLE users ADD COLUMN notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- People who had switched email off keep getting no email, and now see their
-- notifications on the site instead.
UPDATE users
   SET notification_preferences = jsonb_build_object('forum.reply', 'site')
 WHERE email_notifications_enabled = false;

ALTER TABLE users DROP COLUMN email_notifications_enabled;

-- Notifications shown on the site: the bell, the bar and the list.
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(64) NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  subject TEXT NOT NULL,
  excerpt TEXT,
  job_id UUID REFERENCES notification_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  read_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
