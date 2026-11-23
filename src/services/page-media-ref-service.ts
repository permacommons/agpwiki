import type { PoolClient } from 'pg';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { extractMediaSlugsFromSources } from '../lib/media-render.js';

type PageBody = Record<string, string> | null | undefined;
type PageSource = { id: string; body: PageBody };
const BACKFILL = '043_page_media_refs.backfill';

async function insertPageMediaRefs(transaction: PoolClient, pages: PageSource[]): Promise<void> {
  const references = pages.flatMap(({ id, body }) =>
    Object.entries(body ?? {}).flatMap(([language, source]) =>
      [...extractMediaSlugsFromSources([source])]
        .filter(slug => slug.length <= 200)
        .map((media_slug, index) => ({ page_id: id, language, position: index + 1, media_slug }))
    )
  );
  if (references.length === 0) return;

  await transaction.query(
    `INSERT INTO page_media_refs (page_id, language, position, media_slug)
     SELECT page_id, language, position, media_slug
     FROM jsonb_to_recordset($1::jsonb) AS ref(page_id uuid, language text, position integer, media_slug text)`,
    [JSON.stringify(references)]
  );
}

export async function replacePageMediaRefs(transaction: PoolClient, id: string, body: PageBody): Promise<void> {
  await transaction.query('DELETE FROM page_media_refs WHERE page_id = $1', [id]);
  await insertPageMediaRefs(transaction, [{ id, body }]);
}

export async function backfillPageMediaRefs(dal: DataAccessLayer): Promise<void> {
  await dal.transaction(async transaction => {
    const applied = await transaction.query('SELECT 1 FROM migrations WHERE filename = $1', [BACKFILL]);
    if (applied.rowCount) return;

    await transaction.query('LOCK TABLE pages IN SHARE ROW EXCLUSIVE MODE');
    await transaction.query('DELETE FROM page_media_refs');
    let cursor: string | null = null;
    for (;;) {
      const { rows } = await transaction.query<PageSource>(
        `SELECT id, body FROM pages
          WHERE _old_rev_of IS NULL AND _rev_deleted = false AND body IS NOT NULL
            AND ($1::uuid IS NULL OR id > $1)
          ORDER BY id LIMIT 500`,
        [cursor]
      );
      const lastPage = rows.at(-1);
      if (!lastPage) break;
      await insertPageMediaRefs(transaction, rows);
      cursor = lastPage.id;
    }

    await transaction.query('INSERT INTO migrations (filename) VALUES ($1)', [BACKFILL]);
  });
}
