import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError } from '../lib/errors.js';
import { BLOG_ADMIN_ROLE, userHasRole, WIKI_ADMIN_ROLE } from './roles.js';

export const canUseWikiAdminTools = (roles: string[]) => roles.includes(WIKI_ADMIN_ROLE);

export const canUseBlogAdminTools = (roles: string[]) => roles.includes(BLOG_ADMIN_ROLE);

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

export const assertCanDeleteCitation = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

export const assertCanDeleteCitationClaim = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

export const assertCanDeletePageCheck = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, WIKI_ADMIN_ROLE);

export const assertCanDeleteBlogPost = async (dal: DataAccessLayer, userId: string) =>
  assertUserHasRole(dal, userId, BLOG_ADMIN_ROLE);
