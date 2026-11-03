ALTER TABLE pages ADD COLUMN body_edit_counts JSONB NOT NULL DEFAULT '{}';

WITH languages AS (
  SELECT DISTINCT COALESCE(_old_rev_of, id) AS page_id,
         jsonb_object_keys(COALESCE(body, '{}')) AS language
    FROM pages
), changes AS (
  SELECT p.id, p._rev_date, p._rev_id, l.page_id, l.language,
         ((p.body->>l.language) IS DISTINCT FROM
          lag(p.body->>l.language) OVER (
            PARTITION BY l.page_id, l.language ORDER BY p._rev_date, p._rev_id
          ))::int AS changed
    FROM pages p
    JOIN languages l ON l.page_id = COALESCE(p._old_rev_of, p.id)
), counts AS (
  SELECT id, language,
         sum(changed) OVER (
           PARTITION BY page_id, language ORDER BY _rev_date, _rev_id
         ) AS edit_count
    FROM changes
), per_revision AS (
  SELECT id, jsonb_object_agg(language, edit_count) AS edit_counts
    FROM counts GROUP BY id
)
UPDATE pages p SET body_edit_counts = r.edit_counts
  FROM per_revision r WHERE p.id = r.id;

CREATE INDEX pages_page_revision_idx ON pages (COALESCE(_old_rev_of, id), _rev_id);

CREATE FUNCTION maintain_page_body_edit_counts() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  language text;
  previous_body jsonb := '{}';
BEGIN
  -- Archived rows carry the counters captured with their original revision.
  IF NEW._old_rev_of IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    previous_body := COALESCE(OLD.body, '{}');
    NEW.body_edit_counts := OLD.body_edit_counts;
  ELSE
    NEW.body_edit_counts := '{}';
  END IF;

  FOR language IN
    SELECT jsonb_object_keys(previous_body)
    UNION
    SELECT jsonb_object_keys(COALESCE(NEW.body, '{}'))
  LOOP
    IF (previous_body->>language) IS DISTINCT FROM (NEW.body->>language) THEN
      NEW.body_edit_counts := jsonb_set(
        NEW.body_edit_counts, ARRAY[language],
        to_jsonb(COALESCE((NEW.body_edit_counts->>language)::bigint, 0) + 1)
      );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pages_body_edit_counts
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION maintain_page_body_edit_counts();
