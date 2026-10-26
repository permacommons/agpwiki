import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError } from '../lib/errors.js';
import {
  BLOG_ADMIN_ROLE,
  FORUM_MODERATOR_ROLE,
  hasRole,
  SITE_ADMIN_ROLE,
  userHasRole,
  WIKI_ADMIN_ROLE,
} from './roles.js';

export const canUseWikiAdminTools = (roles: string[]) => hasRole(roles, WIKI_ADMIN_ROLE);

export const canUseBlogAdminTools = (roles: string[]) => hasRole(roles, BLOG_ADMIN_ROLE);

const assertUserHasRole = async (
  dal: DataAccessLayer,
  userId: string,
  role: string
): Promise<void> => {
  const allowed = await userHasRole(dal, userId, role);
  if (allowed) return;
  throw new ForbiddenError(`User does not have ${role} role.`);
};

export const assertCanDeleteWikiPage = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

export const assertCanProtectWikiPage = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

// Like other changes to a person's rights, through the user rights tool.
export const assertCanManageExperiencedStatus = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, SITE_ADMIN_ROLE);

export const assertCanDeleteCitation = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

export const assertCanDeleteCitationClaim = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

export const assertCanDeleteMedia = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

export const assertCanDeletePageCheck = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

export const assertCanDeleteBlogPost = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, BLOG_ADMIN_ROLE);

export const assertCanModerateForum = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, FORUM_MODERATOR_ROLE);
