import { initializePostgreSQL } from './db.js';

type CacheEntry = {
  value: number;
  expiresAt: number;
};

const ARTICLE_COUNT_TTL_MS = 60_000;
let articleCountCache: CacheEntry | null = null;

export const getArticleCount = async () => {
  const now = Date.now();
  if (articleCountCache && articleCountCache.expiresAt > now) {
    return articleCountCache.value;
  }

  const dal = await initializePostgreSQL();
  const result = await dal.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM pages
     WHERE _old_rev_of IS NULL
       AND _rev_deleted = false
       AND slug NOT LIKE 'meta/%'
       AND slug NOT LIKE 'tool/%'`
  );
  const count = Number(result.rows[0]?.count ?? 0);
  articleCountCache = { value: count, expiresAt: now + ARTICLE_COUNT_TTL_MS };
  return count;
};
