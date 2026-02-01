DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'account_requests'
      AND column_name = 'portfolio'
  ) THEN
    ALTER TABLE account_requests
      RENAME COLUMN portfolio TO worked_on;
  END IF;
END
$$;
