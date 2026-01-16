CREATE UNIQUE INDEX idx_api_tokens_user_label_active
  ON api_tokens (user_id, label)
  WHERE revoked_at IS NULL AND label IS NOT NULL;
