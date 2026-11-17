import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError, InvalidRequestError } from '../lib/errors.js';
import { isProfileSlug, profileUsernameOf } from '../lib/profile-paths.js';
import { getUserRoles, userHasRole, WIKI_ADMIN_ROLE } from './roles.js';

export interface ProfileOwner {
  id: string;
  username: string;
  displayName: string;
  createdAt: Date | null;
}

export const findProfileOwner = async (
  dalInstance: DataAccessLayer,
  username: string
): Promise<ProfileOwner | null> => {
  const result = await dalInstance.query(
    'SELECT id, username, display_name, created_at FROM users WHERE username = $1',
    [username]
  );
  const row = result.rows[0] as
    | { id: string; username: string; display_name: string; created_at: Date | null }
    | undefined;
  return row
    ? { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at ?? null }
    : null;
};

/** The contributor whose profile this address is, if any. */
export const findProfileOwnerBySlug = async (dalInstance: DataAccessLayer, slug: string) => {
  const username = profileUsernameOf(slug);
  return username ? findProfileOwner(dalInstance, username) : null;
};

export interface AccountSummary {
  edits: { pages: number; citations: number; claims: number; checks: number; total: number };
  pagesCreated: number;
  comments: number;
  roles: string[];
}

/**
 * What a contributor has done, counted from the revisions and comments
 * themselves: every saved version counts as one edit.
 */
export const loadAccountSummary = async (dalInstance: DataAccessLayer, userId: string): Promise<AccountSummary> => {
  const result = await dalInstance.query(
    `SELECT
       (SELECT COUNT(*) FROM pages WHERE _rev_user = $1)::int AS pages,
       (SELECT COUNT(*) FROM citations WHERE _rev_user = $1)::int AS citations,
       (SELECT COUNT(*) FROM citation_claims WHERE _rev_user = $1)::int AS claims,
       (SELECT COUNT(*) FROM page_checks WHERE _rev_user = $1)::int AS checks,
       (SELECT COUNT(*) FROM pages WHERE _rev_user = $1 AND 'create' = ANY(_rev_tags))::int AS pages_created,
       (SELECT COUNT(*)
          FROM forum_comments f
          JOIN forum_comments c
            ON c.id = COALESCE(f._old_rev_of, f.id) AND c._old_rev_of IS NULL AND c._rev_deleted = false
         WHERE f._rev_user = $1 AND 'create' = ANY(f._rev_tags))::int AS comments`,
    [userId]
  );
  const row = (result.rows[0] ?? {}) as Record<string, number>;
  const edits = {
    pages: Number(row.pages) || 0,
    citations: Number(row.citations) || 0,
    claims: Number(row.claims) || 0,
    checks: Number(row.checks) || 0,
  };
  return {
    edits: { ...edits, total: edits.pages + edits.citations + edits.claims + edits.checks },
    pagesCreated: Number(row.pages_created) || 0,
    comments: Number(row.comments) || 0,
    roles: await getUserRoles(dalInstance, userId),
  };
};

/** Whether someone may write a profile's text: its contributor and wiki admins. */
export const canEditProfile = async (dalInstance: DataAccessLayer, owner: ProfileOwner, userId?: string | null) =>
  Boolean(userId) &&
  (owner.id === userId || (await userHasRole(dalInstance, userId as string, WIKI_ADMIN_ROLE)));

/**
 * Refuses to write a page under user/ unless it is the profile of an
 * existing contributor and the writer is that contributor or a wiki admin.
 */
export const assertCanWriteProfilePage = async (dalInstance: DataAccessLayer, slug: string, userId: string) => {
  if (!isProfileSlug(slug)) return;
  const owner = await findProfileOwnerBySlug(dalInstance, slug);
  if (!owner) {
    throw new InvalidRequestError('Pages under user/ are contributor profiles: user/<username> of an existing contributor.', {
      slug,
    });
  }
  if (!(await canEditProfile(dalInstance, owner, userId))) {
    throw new ForbiddenError('Only the contributor and wiki admins can edit this profile.', {
      slug,
      profileOf: owner.username,
    });
  }
};
