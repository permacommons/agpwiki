import { articleSlugExclusions } from '../lib/page-address.js';
import WikiPage from './wiki-page.js';

export const articlePages = () => {
  const { notLike } = WikiPage.ops;
  const [first, ...rest] = articleSlugExclusions;
  let query = WikiPage.filterWhere({ slug: notLike(first) });
  for (const pattern of rest) query = query.and({ slug: notLike(pattern) });
  return query;
};
