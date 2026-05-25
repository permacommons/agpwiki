import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';

import { InvalidRequestError, NotFoundError } from '../lib/errors.js';
import {
  getUserRoles,
  isValidRole,
  SITE_ADMIN_ROLE,
  VALID_ROLES,
  type ValidRole,
} from './roles.js';

export const EDITABLE_USER_RIGHTS = VALID_ROLES.filter(
  role => role !== SITE_ADMIN_ROLE
) as Exclude<ValidRole, typeof SITE_ADMIN_ROLE>[];

export type EditableUserRight = (typeof EDITABLE_USER_RIGHTS)[number];

export type UserRightsSummary = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  roles: ValidRole[];
};

export type UserRightsChange = {
  role: EditableUserRight;
  before: boolean;
  after: boolean;
};

export type UserRightsUpdateResult = {
  user: UserRightsSummary;
  changes: UserRightsChange[];
  beforeRoles: ValidRole[];
  afterRoles: ValidRole[];
};

export type UserRightsSearchOptions = {
  includeBlocked?: boolean;
  limit?: number;
};

const normalizeRoles = (roles: string[]): ValidRole[] =>
  VALID_ROLES.filter(role => roles.includes(role));

const assertEditableRolesOnly = (roles: string[]) => {
  const invalidRoles = roles.filter(role => !isValidRole(role));
  if (invalidRoles.length) {
    throw new InvalidRequestError('Unknown user right requested.', { roles: invalidRoles });
  }

  if (roles.includes(SITE_ADMIN_ROLE)) {
    throw new InvalidRequestError('site_admin cannot be changed from the web UI.', {
      role: SITE_ADMIN_ROLE,
    });
  }
};

const mapUserRightsRow = (row: Record<string, unknown>): UserRightsSummary => ({
  id: String(row.id),
  username: String(row.username ?? ''),
  displayName: String(row.display_name ?? ''),
  email: String(row.email ?? ''),
  roles: normalizeRoles(Array.isArray(row.roles) ? row.roles.map(String) : []),
});

export async function searchVerifiedUsersWithRights(
  dal: DataAccessLayer,
  query: string,
  options: number | UserRightsSearchOptions = 100
): Promise<UserRightsSummary[]> {
  const trimmedQuery = query.trim();
  const limit = typeof options === 'number' ? options : (options.limit ?? 100);
  const includeBlocked = typeof options === 'number' ? false : Boolean(options.includeBlocked);
  const clampedLimit = Math.min(Math.max(limit, 1), 200);
  const params: Array<string | number> = [clampedLimit];
  const clauses = ['u.email_verified_at IS NOT NULL'];

  if (!includeBlocked) {
    clauses.push('u.blocked_at IS NULL');
  }

  if (trimmedQuery) {
    params.push(`%${trimmedQuery}%`);
    const searchParam = `$${params.length}`;
    clauses.push(`(
      u.username ILIKE ${searchParam} OR
      u.display_name ILIKE ${searchParam} OR
      u.email ILIKE ${searchParam}
    )`);
  }

  const result = await dal.query(
    `SELECT
       u.id,
       u.username,
       u.display_name,
       u.email,
       COALESCE(array_agg(ur.role ORDER BY ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     WHERE ${clauses.join('\n       AND ')}
     GROUP BY u.id, u.username, u.display_name, u.email
     ORDER BY lower(u.display_name), lower(u.username), lower(u.email)
     LIMIT $1`,
    params
  );

  return result.rows.map(mapUserRightsRow);
}

export async function getVerifiedUserRights(
  dal: DataAccessLayer,
  userId: string
): Promise<UserRightsSummary | null> {
  const result = await dal.query(
    `SELECT
       u.id,
       u.username,
       u.display_name,
       u.email,
       COALESCE(array_agg(ur.role ORDER BY ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     WHERE u.id = $1
       AND u.email_verified_at IS NOT NULL
     GROUP BY u.id, u.username, u.display_name, u.email`,
    [userId]
  );

  return result.rows[0] ? mapUserRightsRow(result.rows[0]) : null;
}

export async function updateUserRightsBelowSiteAdmin(
  dal: DataAccessLayer,
  userId: string,
  desiredEditableRoles: string[]
): Promise<UserRightsUpdateResult> {
  const uniqueDesiredRoles = [...new Set(desiredEditableRoles)];
  assertEditableRolesOnly(uniqueDesiredRoles);

  const beforeUser = await getVerifiedUserRights(dal, userId);
  if (!beforeUser) {
    throw new NotFoundError('Verified user not found.', { userId });
  }

  const beforeRoles = await getUserRoles(dal, userId);
  const normalizedBeforeRoles = normalizeRoles(beforeRoles);
  const beforeEditableRoles = new Set(
    normalizedBeforeRoles.filter((role): role is EditableUserRight =>
      EDITABLE_USER_RIGHTS.includes(role as EditableUserRight)
    )
  );
  const desiredRoleSet = new Set(uniqueDesiredRoles as EditableUserRight[]);

  const changes = EDITABLE_USER_RIGHTS.map(role => ({
    role,
    before: beforeEditableRoles.has(role),
    after: desiredRoleSet.has(role),
  })).filter(change => change.before !== change.after);

  if (changes.length) {
    await dal.query('BEGIN');
    try {
      await dal.query('DELETE FROM user_roles WHERE user_id = $1 AND role = ANY($2::text[])', [
        userId,
        EDITABLE_USER_RIGHTS,
      ]);

      for (const role of uniqueDesiredRoles) {
        await dal.query(
          'INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id, role) DO NOTHING',
          [userId, role]
        );
      }
      await dal.query('COMMIT');
    } catch (error) {
      await dal.query('ROLLBACK');
      throw error;
    }
  }

  const afterUser = await getVerifiedUserRights(dal, userId);
  if (!afterUser) {
    throw new NotFoundError('Verified user not found.', { userId });
  }

  return {
    user: afterUser,
    changes,
    beforeRoles: normalizedBeforeRoles,
    afterRoles: afterUser.roles,
  };
}
