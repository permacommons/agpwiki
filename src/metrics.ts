import WikiPage from './models/wiki-page.js';

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

  const { notLike } = WikiPage.ops;
  const count = await WikiPage.filterWhere({ slug: notLike('meta/%') })
    .and({ slug: notLike('tool/%') })
    .count();

  articleCountCache = { value: count, expiresAt: now + ARTICLE_COUNT_TTL_MS };
  return count;
};
