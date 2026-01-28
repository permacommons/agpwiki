import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';

export const SITE_ADMIN_ROLE = 'site_admin';
export const WIKI_ADMIN_ROLE = 'wiki_admin';
export const BLOG_AUTHOR_ROLE = 'blog_author';
export const BLOG_ADMIN_ROLE = 'blog_admin';

export const VALID_ROLES = [
  SITE_ADMIN_ROLE,
  WIKI_ADMIN_ROLE,
  BLOG_AUTHOR_ROLE,
  BLOG_ADMIN_ROLE,
] as const;
export type ValidRole = (typeof VALID_ROLES)[number];

export const ROLE_DESCRIPTIONS: Record<ValidRole, string> = {
  [SITE_ADMIN_ROLE]: 'Manage site-wide settings and account requests.',
  [WIKI_ADMIN_ROLE]: 'Administer wiki content and deletions.',
  [BLOG_AUTHOR_ROLE]: 'Create and update blog posts.',
  [BLOG_ADMIN_ROLE]: 'Delete blog posts and manage blog content.',
};

export function isValidRole(role: string): role is ValidRole {
  return VALID_ROLES.includes(role as ValidRole);
}

export function listRoles(): Array<{ role: ValidRole; description: string }> {
  return VALID_ROLES.map(role => ({
    role,
    description: ROLE_DESCRIPTIONS[role],
  }));
}

/**
 * Fetch all roles for a user from the user_roles table.
 *
 * @param dal - Database access layer
 * @param userId - User ID to look up roles for
 * @returns Array of role strings
 */
export async function getUserRoles(dal: DataAccessLayer, userId: string): Promise<string[]> {
  const result = await dal.query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
  return result.rows.map(row => row.role as string);
}

/**
 * Check if a user has a specific role.
 *
 * @param roles - Array of user's roles
 * @param role - Role to check for
 * @returns True if user has the role
 */
export function hasRole(roles: string[], role: string): boolean {
  return roles.includes(role);
}
