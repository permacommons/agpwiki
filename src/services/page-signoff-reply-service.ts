import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError, NotFoundError, ValidationCollector } from '../lib/errors.js';
import type { PageSignoffReplyInstance } from '../models/manifests/page-signoff-reply.js';
import PageSignoff from '../models/page-signoff.js';
import PageSignoffReply from '../models/page-signoff-reply.js';
import { canSignOffPages, isSignoffPageSlug } from './page-signoff-service.js';
import { userHasRole, WIKI_ADMIN_ROLE } from './roles.js';
import { ensureNonEmptyString, ensureOptionalLanguage, normalizeSlugInput } from './validation.js';
import { readWikiPage } from './wiki-page-service.js';

export interface PageSignoffReplyResult {
  id: string;
  signoffId: string;
  pageId: string;
  userId: string;
  body: string;
  bodyLanguage: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface PageSignoffReplyInput {
  slug: string;
  signoffId: string;
  body: string;
  bodyLanguage: string;
}

const toReplyResult = (reply: PageSignoffReplyInstance): PageSignoffReplyResult => ({
  id: reply.id,
  signoffId: reply.signoffId,
  pageId: reply.pageId,
  userId: reply.userId,
  body: reply.body,
  bodyLanguage: reply.bodyLanguage,
  createdAt: reply.createdAt ?? null,
  updatedAt: reply.updatedAt ?? null,
});

const validateBody = (body: string, bodyLanguage: string, errors: ValidationCollector) => {
  if (typeof body !== 'string' || !body.trim()) {
    errors.add('body', 'must not be empty.', 'required');
  }
  ensureNonEmptyString(bodyLanguage, 'bodyLanguage', errors);
  ensureOptionalLanguage(bodyLanguage, 'bodyLanguage', errors);
};

const assertCanWrite = async (dalInstance: DataAccessLayer, userId: string) => {
  if (!(await canSignOffPages(dalInstance, userId))) {
    throw new ForbiddenError('Blocked or unknown users cannot reply to positions.');
  }
};

/**
 * Visible replies for the given positions, oldest first, grouped by position.
 * Deleted and hidden replies are left out.
 */
export const listRepliesForSignoffs = async (
  dalInstance: DataAccessLayer,
  signoffIds: string[]
): Promise<Map<string, PageSignoffReplyResult[]>> => {
  const grouped = new Map<string, PageSignoffReplyResult[]>();
  if (!signoffIds.length) return grouped;
  const result = await dalInstance.query(
    `SELECT id, signoff_id, page_id, user_id, body, body_language, created_at, updated_at
       FROM page_signoff_replies
      WHERE signoff_id = ANY($1) AND deleted_at IS NULL AND hidden_at IS NULL
      ORDER BY created_at ASC`,
    [signoffIds]
  );
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const reply: PageSignoffReplyResult = {
      id: row.id as string,
      signoffId: row.signoff_id as string,
      pageId: row.page_id as string,
      userId: row.user_id as string,
      body: row.body as string,
      bodyLanguage: row.body_language as string,
      createdAt: (row.created_at as Date | null) ?? null,
      updatedAt: (row.updated_at as Date | null) ?? null,
    };
    const list = grouped.get(reply.signoffId) ?? [];
    list.push(reply);
    grouped.set(reply.signoffId, list);
  }
  return grouped;
};

/**
 * Reply to a position's comment. Replies are one level deep: they belong to a
 * position, never to another reply. Positions without a comment take no
 * replies, and neither do withdrawn ones.
 */
export const replyToSignoff = async (
  dalInstance: DataAccessLayer,
  { slug, signoffId, body, bodyLanguage }: PageSignoffReplyInput,
  userId: string
): Promise<PageSignoffReplyResult> => {
  const errors = new ValidationCollector('Invalid reply input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(signoffId, 'signoffId', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  validateBody(body, bodyLanguage, errors);
  errors.throwIfAny();

  await assertCanWrite(dalInstance, userId);
  const page = await readWikiPage(dalInstance, normalizedSlug);
  if (!isSignoffPageSlug(page.slug)) {
    throw new NotFoundError('Positions only exist on proposals.', { slug: page.slug });
  }
  const signoff = await PageSignoff.filterWhere({
    id: signoffId,
    pageId: page.id,
    withdrawnAt: null,
  } as Record<string, unknown>).first();
  if (!signoff) {
    throw new NotFoundError('Position not found on this proposal.', { slug: page.slug, signoffId });
  }
  if (!signoff.comment) {
    const noComment = new ValidationCollector('Invalid reply input.');
    noComment.add('signoffId', 'has no comment to reply to.', 'invalid');
    noComment.throwIfAny();
  }

  const reply = await PageSignoffReply.create({
    signoffId: signoff.id,
    pageId: page.id,
    userId,
    body: body.trim(),
    bodyLanguage,
    createdAt: new Date(),
  });
  return toReplyResult(reply);
};

const findVisibleReply = async (replyId: string) => {
  const reply = await PageSignoffReply.filterWhere({
    id: replyId,
    deletedAt: null,
    hiddenAt: null,
  } as Record<string, unknown>).first();
  if (!reply) throw new NotFoundError('Reply not found.', { replyId });
  return reply;
};

/** Change your own reply. */
export const updateSignoffReply = async (
  dalInstance: DataAccessLayer,
  { replyId, body, bodyLanguage }: { replyId: string; body: string; bodyLanguage: string },
  userId: string
): Promise<PageSignoffReplyResult> => {
  const errors = new ValidationCollector('Invalid reply input.');
  ensureNonEmptyString(replyId, 'replyId', errors);
  validateBody(body, bodyLanguage, errors);
  errors.throwIfAny();

  await assertCanWrite(dalInstance, userId);
  const reply = await findVisibleReply(replyId);
  if (reply.userId !== userId) {
    throw new ForbiddenError('Only the author can change a reply.', { replyId });
  }
  reply.body = body.trim();
  reply.bodyLanguage = bodyLanguage;
  reply.updatedAt = new Date();
  await reply.save();
  return toReplyResult(reply);
};

/**
 * Remove a reply. The author deletes their own; a wiki admin hides someone
 * else's for moderation. Either way it no longer shows.
 */
export const removeSignoffReply = async (
  dalInstance: DataAccessLayer,
  { replyId }: { replyId: string },
  userId: string
): Promise<{ id: string; removal: 'deleted' | 'hidden' }> => {
  const errors = new ValidationCollector('Invalid reply input.');
  ensureNonEmptyString(replyId, 'replyId', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  errors.throwIfAny();

  const reply = await findVisibleReply(replyId);
  if (reply.userId === userId) {
    reply.deletedAt = new Date();
    await reply.save();
    return { id: reply.id, removal: 'deleted' };
  }
  if (!(await userHasRole(dalInstance, userId, WIKI_ADMIN_ROLE))) {
    throw new ForbiddenError('Only the author or a wiki admin can remove a reply.', { replyId });
  }
  reply.hiddenAt = new Date();
  reply.hiddenBy = userId;
  await reply.save();
  return { id: reply.id, removal: 'hidden' };
};
