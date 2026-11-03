import { isApplicationSlug, reservedSlugs, toAddressForm } from './slug.js';

export const PAGE_NAMESPACES = [
  { name: 'article', prefix: '' },
  { name: 'meta', prefix: 'meta/' },
] as const;

export type PageNamespace = typeof PAGE_NAMESPACES[number]['name'];

const prefixedNamespaces = PAGE_NAMESPACES.filter(entry => entry.prefix.length > 0)
  .sort((a, b) => b.prefix.length - a.prefix.length);
const defaultNamespace = PAGE_NAMESPACES.find(entry => entry.prefix === '');
if (!defaultNamespace) throw new Error('Missing default page namespace');
export const DEFAULT_PAGE_NAMESPACE = defaultNamespace;

export interface PageAddress {
  slug: string;
  namespace: PageNamespace;
  localName: string;
}

export const resolvePageAddress = (value: string): PageAddress | null => {
  const slug = toAddressForm(value);
  if (!slug || isApplicationSlug(slug)) return null;
  const definition = prefixedNamespaces.find(entry => slug.startsWith(entry.prefix))
    ?? DEFAULT_PAGE_NAMESPACE;
  return { slug, namespace: definition.name, localName: slug.slice(definition.prefix.length) };
};

export const isArticleSlug = (slug: string) => resolvePageAddress(slug)?.namespace === 'article';

export const articleSlugExclusions = [
  ...prefixedNamespaces.map(entry => `${entry.prefix}%`),
  ...[...reservedSlugs].flatMap(prefix => [prefix, `${prefix}/%`]),
];

// Only internal identifiers and registered prefixes enter this SQL fragment;
// user-provided addresses and namespaces remain query parameters.
export const pageNamespaceSql = (column = 'slug') => {
  if (!/^(?:[a-z_]+\.)?[a-z_]+$/.test(column)) throw new Error('Invalid SQL column');
  const reserved = [...reservedSlugs].map(prefix => `'${prefix.replaceAll("'", "''")}'`).join(', ');
  const branches = prefixedNamespaces.map(entry =>
    `WHEN starts_with(${column}, '${entry.prefix.replaceAll("'", "''")}') THEN '${entry.name}'`
  ).join('\n    ');
  return `(CASE WHEN split_part(${column}, '/', 1) IN (${reserved}) THEN NULL
    ${branches} ELSE '${DEFAULT_PAGE_NAMESPACE.name}' END)`;
};
