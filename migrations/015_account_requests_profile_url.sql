DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'account_requests'
      AND column_name = 'worked_on'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'account_requests'
      AND column_name = 'profile_url'
  ) THEN
    ALTER TABLE account_requests
      RENAME COLUMN worked_on TO profile_url;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'account_requests'
      AND column_name = 'profile_url'
  ) THEN
    ALTER TABLE account_requests
      ALTER COLUMN profile_url DROP NOT NULL;
  END IF;
END
$$;
