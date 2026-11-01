import { getSiteBaseUrl } from '../../services/site-config.js';

/** The query string of a request URL, including its leading "?", or "". */
export const queryStringOf = (originalUrl: string | undefined) => {
  const index = originalUrl?.indexOf('?') ?? -1;
  return index >= 0 && originalUrl ? originalUrl.slice(index) : '';
};

/** Site path of a wiki page, keeping the slashes of nested slugs. */
export const slugPath = (slug: string) => `/${slug.split('/').map(encodeURIComponent).join('/')}`;

/** Absolute URL of a site path, for <link rel="canonical">. */
export const canonicalUrlFor = (path: string) => `${getSiteBaseUrl()}${path}`;
