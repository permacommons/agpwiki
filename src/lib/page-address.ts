import { isApplicationSlug, reservedSlugs, toAddressForm } from './slug.js';

export type PageNamespace = 'article' | 'meta';

export interface PageAddress {
  slug: string;
  namespace: PageNamespace;
  localName: string;
}

const META_PREFIX = 'meta/';

export const resolvePageAddress = (value: string): PageAddress | null => {
  const slug = toAddressForm(value);
  if (!slug || isApplicationSlug(slug)) return null;
  const namespace = slug.startsWith(META_PREFIX) ? 'meta' : 'article';
  return { slug, namespace, localName: namespace === 'meta' ? slug.slice(META_PREFIX.length) : slug };
};

export const isArticleSlug = (slug: string) => resolvePageAddress(slug)?.namespace === 'article';

export const articleSlugExclusions = [
  `${META_PREFIX}%`,
  ...[...reservedSlugs].flatMap(prefix => [prefix, `${prefix}/%`]),
];

// Only internal identifiers and registered prefixes enter this SQL fragment;
// user-provided addresses and namespaces remain query parameters.
export const pageNamespaceSql = (column = 'slug') => {
  if (!/^(?:[a-z_]+\.)?[a-z_]+$/.test(column)) throw new Error('Invalid SQL column');
  const reserved = [...reservedSlugs].map(prefix => `'${prefix.replaceAll("'", "''")}'`).join(', ');
  return `(CASE WHEN split_part(${column}, '/', 1) IN (${reserved}) THEN NULL
    WHEN ${column} LIKE '${META_PREFIX}%' THEN 'meta' ELSE 'article' END)`;
};
