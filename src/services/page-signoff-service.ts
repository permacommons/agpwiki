import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError, NotFoundError, ValidationCollector } from '../lib/errors.js';
import type { PageSignoffInstance } from '../models/manifests/page-signoff.js';
import PageSignoff from '../models/page-signoff.js';
import User from '../models/user.js';
import {
  ADMIN_EVENT_TARGET_WIKI_PAGE,
  ADMIN_EVENT_WIKI_PAGE_SIGNED_OFF,
  ADMIN_EVENT_WIKI_PAGE_SIGNOFF_WITHDRAWN,
  recordAdminEvent,
} from './admin-event-service.js';
import { reattachForumThread } from './forum-service.js';
import { ensureNonEmptyString, ensureOptionalLanguage, ensureOptionalString, normalizeSlugInput } from './validation.js';
import { readWikiPage } from './wiki-page-service.js';

export const SIGNOFF_PAGE_PREFIX = 'meta/proposals/';
export const SIGNOFF_STANCES = ['support', 'neutral', 'oppose'] as const;
export type SignoffStance = (typeof SIGNOFF_STANCES)[number];

const isSignoffStance = (value: unknown): value is SignoffStance =>
  typeof value === 'string' && (SIGNOFF_STANCES as readonly string[]).includes(value);

export interface PageSignoffResult {
  id: string;
  pageId: string;
  revId: string;
  userId: string;
  stance: SignoffStance;
  comment: string | null;
  commentLanguage: string | null;
  signedAt: Date | null;
}

export interface PageSignoffInput {
  slug: string;
  stance: string;
  comment?: string | null;
  commentLanguage?: string | null;
}

export const isSignoffPageSlug = (slug: string) => slug.startsWith(SIGNOFF_PAGE_PREFIX);

const toPageSignoffResult = (signoff: PageSignoffInstance): PageSignoffResult => ({
  id: signoff.id,
  pageId: signoff.pageId,
  revId: signoff.revId,
  userId: signoff.userId,
  stance: isSignoffStance(signoff.stance) ? signoff.stance : 'support',
  comment: signoff.comment ?? null,
  commentLanguage: signoff.commentLanguage ?? null,
  signedAt: signoff.signedAt ?? null,
});

export const canSignOffPages = async (_dalInstance: DataAccessLayer, userId?: string | null) => {
  if (!userId) return false;
  const user = await User.filterWhere({ id: userId }).first();
  return Boolean(user && !user.blockedAt);
};

/**
 * Revision IDs among the given ones whose title or body differ from the
 * page's current revision. Revisions that only changed metadata, such as a
 * proposal's status, are not counted as changes to the proposal.
 */
export const findRevisionsWithChangedText = async (
  dalInstance: DataAccessLayer,
  pageId: string,
  revIds: string[]
): Promise<Set<string>> => {
  const changed = new Set<string>();
  if (!revIds.length) return changed;
  const result = await dalInstance.query(
    `SELECT r._rev_id AS rev_id
       FROM pages r
       JOIN pages c ON c.id = $1 AND c._old_rev_of IS NULL
      WHERE (r.id = $1 OR r._old_rev_of = $1)
        AND r._rev_id = ANY($2)
        AND (r.title IS DISTINCT FROM c.title OR r.body IS DISTINCT FROM c.body)`,
    [pageId, revIds]
  );
  for (const row of result.rows as Array<{ rev_id: string }>) changed.add(row.rev_id);
  return changed;
};

export const listActivePageSignoffs = async (
  _dalInstance: DataAccessLayer,
  pageId: string
): Promise<PageSignoffResult[]> => {
  const signoffs = await PageSignoff.filterWhere({ pageId, withdrawnAt: null } as Record<
    string,
    unknown
  >).run();
  return signoffs
    .map(toPageSignoffResult)
    .sort((a, b) => (a.signedAt?.getTime() ?? 0) - (b.signedAt?.getTime() ?? 0));
};

const findActiveSignoff = async (pageId: string, userId: string) =>
  PageSignoff.filterWhere({ pageId, userId, withdrawnAt: null } as Record<string, unknown>).first();

const resolveSignoffPage = async (
  dalInstance: DataAccessLayer,
  slug: string,
  userId: string,
  message: string
) => {
  const errors = new ValidationCollector(message);
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  errors.throwIfAny();

  if (!(await canSignOffPages(dalInstance, userId))) {
    throw new ForbiddenError('Blocked or unknown users cannot sign off proposals.', {
      slug: normalizedSlug,
    });
  }
  const page = await readWikiPage(dalInstance, normalizedSlug);
  if (!isSignoffPageSlug(page.slug)) {
    throw new ForbiddenError(`Only pages under ${SIGNOFF_PAGE_PREFIX} can be signed off.`, {
      slug: page.slug,
    });
  }
  return page;
};

export const signOffPage = async (
  dalInstance: DataAccessLayer,
  { slug, stance, comment, commentLanguage }: PageSignoffInput,
  userId: string
): Promise<PageSignoffResult> => {
  const errors = new ValidationCollector('Invalid sign-off input.');
  if (!isSignoffStance(stance)) {
    errors.add('stance', `Must be one of: ${SIGNOFF_STANCES.join(', ')}.`, 'invalid');
  }
  ensureOptionalString(comment, 'comment', errors);
  ensureOptionalLanguage(commentLanguage, 'commentLanguage', errors);
  if (typeof comment === 'string' && comment.trim()) {
    ensureNonEmptyString(commentLanguage, 'commentLanguage', errors);
  }
  errors.throwIfAny();

  const page = await resolveSignoffPage(dalInstance, slug, userId, 'Invalid sign-off input.');
  const previous = await findActiveSignoff(page.id, userId);
  if (previous) {
    previous.withdrawnAt = new Date();
    await previous.save();
  }

  const normalizedComment = comment?.trim() ? comment.trim() : null;
  const signoff = await PageSignoff.create({
    pageId: page.id,
    revId: page.currentRevId,
    userId,
    stance,
    comment: normalizedComment,
    commentLanguage: normalizedComment ? commentLanguage : null,
    signedAt: new Date(),
  });
  if (previous) {
    // A changed position is saved as a new one; the forum thread with the
    // replies to it follows, so the conversation stays in one place.
    await reattachForumThread({ type: 'position', id: previous.id }, signoff.id, userId);
  }

  await recordAdminEvent(dalInstance, {
    eventType: ADMIN_EVENT_WIKI_PAGE_SIGNED_OFF,
    actorUserId: userId,
    targetType: ADMIN_EVENT_TARGET_WIKI_PAGE,
    targetId: page.id,
    targetRevId: page.currentRevId,
    details: {
      stance,
      comment: normalizedComment,
      commentLanguage: normalizedComment ? commentLanguage : null,
      previousStance: previous?.stance ?? null,
    },
  });

  return toPageSignoffResult(signoff);
};

export const withdrawPageSignoff = async (
  dalInstance: DataAccessLayer,
  { slug }: { slug: string },
  userId: string
): Promise<PageSignoffResult> => {
  const page = await resolveSignoffPage(dalInstance, slug, userId, 'Invalid sign-off input.');
  const existing = await findActiveSignoff(page.id, userId);
  if (!existing) {
    throw new NotFoundError('You have not signed off this page.', { slug: page.slug });
  }

  existing.withdrawnAt = new Date();
  await existing.save();

  await recordAdminEvent(dalInstance, {
    eventType: ADMIN_EVENT_WIKI_PAGE_SIGNOFF_WITHDRAWN,
    actorUserId: userId,
    targetType: ADMIN_EVENT_TARGET_WIKI_PAGE,
    targetId: page.id,
    targetRevId: page.currentRevId,
    details: { signedRevId: existing.revId },
  });

  return toPageSignoffResult(existing);
};
