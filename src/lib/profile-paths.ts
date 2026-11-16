import { escapeHtml } from './html.js';
import { resolvePageAddress } from './page-address.js';
import { encodeSlugPath } from './slug.js';

/**
 * Every contributor has a profile at /user/<username>. Its text is the wiki
 * page with that address, and its Talk tab is that page's discussion.
 */
export const PROFILE_PREFIX = 'user/';

export const profileSlug = (username: string) => `${PROFILE_PREFIX}${username}`;

export const profilePath = (username: string) => `/${encodeSlugPath(profileSlug(username))}`;

/**
 * The username a profile address belongs to, or null when the address is not
 * a profile. Profiles have no subpages.
 */
export const profileUsernameOf = (slug: string): string | null => {
  const address = resolvePageAddress(slug);
  if (address?.namespace !== 'user') return null;
  return address.localName && !address.localName.includes('/') ? address.localName : null;
};

export const isProfileSlug = (slug: string) => resolvePageAddress(slug)?.namespace === 'user';

/** A contributor's name, linked to their profile when the username is known. */
export const renderUserLink = (name: string, username?: string | null, className = 'user-link') =>
  username
    ? `<a class="${className}" href="${escapeHtml(profilePath(username))}">${escapeHtml(name)}</a>`
    : escapeHtml(name);
