CREATE TABLE forum_thread_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscribed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  unsubscribed_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX idx_forum_thread_subscriptions_active_unique
  ON forum_thread_subscriptions (thread_id, user_id)
  WHERE unsubscribed_at IS NULL;

CREATE INDEX idx_forum_thread_subscriptions_thread_active
  ON forum_thread_subscriptions (thread_id, subscribed_at)
  WHERE unsubscribed_at IS NULL;

CREATE INDEX idx_forum_thread_subscriptions_user_active
  ON forum_thread_subscriptions (user_id, subscribed_at)
  WHERE unsubscribed_at IS NULL;
