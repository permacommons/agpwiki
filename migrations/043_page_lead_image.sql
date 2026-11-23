-- The home page features the newest article that has a picture. Each page row
-- records the first image its canonical text embeds, so that article is found
-- through an index instead of by reading article bodies. A trigger keeps the
-- column in step with every way a page row is written.
ALTER TABLE pages ADD COLUMN lead_image VARCHAR(200);

-- The first `![...](/media/<slug>)` in the text whose media is current.
CREATE OR REPLACE FUNCTION page_lead_image(body JSONB, lang TEXT)
RETURNS VARCHAR(200)
LANGUAGE sql
STABLE
AS $$
  SELECT m.slug
    FROM regexp_matches(
           COALESCE(body ->> COALESCE(lang, 'en'), body ->> 'en', ''),
           '\]\(/media/([^)[:space:]]+)\)',
           'g'
         ) WITH ORDINALITY AS r(match, ord)
    JOIN media m
      ON m.slug = r.match[1]
     AND m._old_rev_of IS NULL
     AND m._rev_deleted = false
   ORDER BY r.ord
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION pages_set_lead_image()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.lead_image := page_lead_image(NEW.body, NEW.canonical_language);
  RETURN NEW;
END;
$$;

CREATE TRIGGER pages_lead_image
  BEFORE INSERT OR UPDATE OF body, canonical_language ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_set_lead_image();

UPDATE pages
   SET lead_image = page_lead_image(body, canonical_language)
 WHERE _old_rev_of IS NULL
   AND body::text LIKE '%](/media/%';

CREATE INDEX idx_pages_lead_image_created
  ON pages (created_at DESC)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false AND lead_image IS NOT NULL;
