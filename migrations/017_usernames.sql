ALTER TABLE users
  ADD COLUMN username VARCHAR(128);

WITH normalized AS (
  SELECT
    id,
    COALESCE(NULLIF(REGEXP_REPLACE(LOWER(BTRIM(display_name)), '[\s_-]+', '', 'g'), ''), 'user') AS base_username,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(NULLIF(REGEXP_REPLACE(LOWER(BTRIM(display_name)), '[\s_-]+', '', 'g'), ''), 'user')
      ORDER BY created_at, id
    ) AS ordinal
  FROM users
),
resolved AS (
  SELECT
    id,
    CASE
      WHEN ordinal = 1 THEN base_username
      ELSE LEFT(base_username, GREATEST(1, 128 - LENGTH(ordinal::text))) || ordinal::text
    END AS username
  FROM normalized
)
UPDATE users u
SET username = resolved.username
FROM resolved
WHERE u.id = resolved.id;

ALTER TABLE users
  ALTER COLUMN username SET NOT NULL;

CREATE UNIQUE INDEX idx_users_username_unique ON users (username);
