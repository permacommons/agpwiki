import { articlePages } from './models/page-scope.js';

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

  const count = await articlePages().count();

  articleCountCache = { value: count, expiresAt: now + ARTICLE_COUNT_TTL_MS };
  return count;
};
