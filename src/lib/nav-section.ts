export type NavSection = 'blog' | 'forum' | 'tools' | 'contribute' | 'developers';

const CONTRIBUTE_PAGES = ['/meta/help', '/meta/contributing', '/meta/setup', '/meta/wishlist'];
const DEVELOPER_PAGES = ['/meta/developers', '/meta/mcp-reference'];
const TOOL_PAGES = [
  '/tool/recent-changes',
  '/tool/recent-checks',
  '/tool/recent-citations',
  '/tool/recent-claims',
  '/tool/recent-media',
  '/tool/proposals',
  '/tool/issues',
  '/tool/pages',
  '/tool/missing-wikidata',
];

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * The header section a path belongs to, so the menu can mark where the reader
 * is. Articles and other pages belong to no section.
 */
export const navSectionFor = (rawPath: string): NavSection | null => {
  const path = rawPath.split(/[?#]/)[0].toLowerCase().replace(/\/+$/, '') || '/';
  if (isUnder(path, '/blog')) return 'blog';
  if (isUnder(path, '/tool/forum') || path.endsWith('/discussion')) return 'forum';
  if (TOOL_PAGES.some(prefix => isUnder(path, prefix)) || isUnder(path, '/meta/proposals')) return 'tools';
  if (CONTRIBUTE_PAGES.some(prefix => isUnder(path, prefix))) return 'contribute';
  if (DEVELOPER_PAGES.some(prefix => isUnder(path, prefix))) return 'developers';
  return null;
};
