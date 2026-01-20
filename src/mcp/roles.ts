import type { DataAccessLayer } from '../../dal/lib/data-access-layer.js';

export const SITE_ADMIN_ROLE = 'site_admin';
export const WIKI_ADMIN_ROLE = 'wiki_admin';

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
