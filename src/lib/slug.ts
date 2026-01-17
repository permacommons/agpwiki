const RESERVED_SLUGS = new Set([
  'health',
  'api',
  'mcp',
  'search',
  'tool',
  'blog',
  'cite',
]);

const RESERVED_SUFFIXES = ['comments'];

export const isBlockedSlug = (slug: string) => {
  if (!slug) return true;
  const [prefix] = slug.split('/');
  if (prefix && RESERVED_SLUGS.has(prefix)) return true;

  for (const suffix of RESERVED_SUFFIXES) {
    if (slug === suffix || slug.endsWith(`/${suffix}`)) return true;
  }

  return false;
};

export const reservedSlugs = RESERVED_SLUGS;
export const reservedSuffixes = RESERVED_SUFFIXES;
