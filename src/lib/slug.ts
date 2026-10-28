const RESERVED_SLUGS = new Set([
  '.well-known',
  'health',
  'api',
  'mcp',
  'search',
  'tool',
  'blog',
  'cite',
  'media',
  'media-files',
]);

const RESERVED_SUFFIXES = [
  'comments',
  'checks',
  'operator-edit',
  'operator-edit/dismiss-banner',
  'proposal-links',
  'proposal-status',
  'position-reply',
  'sign-off',
];

// Slugs can contain slashes (meta/proposals/x). Encode each segment, so the
// slashes stay readable in addresses instead of becoming %2F.
export const encodeSlugPath = (slug: string) => slug.split('/').map(encodeURIComponent).join('/');

export const normalizeSlug = (slug: string) =>
  slug.trim().replace(/^\/+/, '').replace(/\/+$/, '');

export const isBlockedSlug = (slug: string) => {
  if (!slug) return true;
  const segments = slug.split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) return true;
  const [prefix] = segments;
  if (prefix && RESERVED_SLUGS.has(prefix)) return true;
  if (/^.+\/checks\/[^/]+$/.test(slug)) return true;

  for (const suffix of RESERVED_SUFFIXES) {
    if (slug === suffix || slug.endsWith(`/${suffix}`)) return true;
  }

  return false;
};

export const reservedSlugs = RESERVED_SLUGS;
export const reservedSuffixes = RESERVED_SUFFIXES;
