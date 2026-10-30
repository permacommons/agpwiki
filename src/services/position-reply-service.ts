import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ConstraintError } from 'rev-dal/lib/errors';
import debug from '../../util/debug.js';
import { ForbiddenError, NotFoundError, ValidationCollector } from '../lib/errors.js';
import PageSignoff from '../models/page-signoff.js';
import User from '../models/user.js';
import { enqueueForumReplyNotification } from './forum-notification-service.js';
import {
  createForumComment,
  createForumThread,
  findAttachedForumThread,
} from './forum-service.js';
import { subscribeUserToForumThread } from './forum-subscription-service.js';
import { enqueueNotificationJob } from './notification-queue.js';
import { notifyPageFollowersOfForumPost } from './page-comment-notification-service.js';
import { canSignOffPages, isSignoffPageSlug } from './page-signoff-service.js';
import { ensureNonEmptyString, ensureOptionalLanguage, normalizeSlugInput } from './validation.js';
import { readWikiPage } from './wiki-page-service.js';

// Replies to a position are forum posts in a thread attached to the
// position, so they live in the one comment system.
export const POSITION_ATTACHMENT = 'position' as const;
const THREAD_TITLE_EXCERPT = 80;

export interface PositionReply {
  id: string;
  threadId: string;
  authorId: string | null;
  body: string;
  bodyLanguage: string | null;
  createdAt: Date | null;
  edited: boolean;
}

export interface PositionReplyThread {
  threadId: string;
  replies: PositionReply[];
}

export interface PositionReplyInput {
  slug: string;
  signoffId: string;
  body: string;
  language: string;
}

const excerpt = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The replies to each of the given positions, oldest first, with the thread
 * they belong to. Positions nobody replied to are left out.
 */
export const listPositionReplies = async (
  dalInstance: DataAccessLayer,
  signoffIds: string[]
): Promise<Map<string, PositionReplyThread>> => {
  const grouped = new Map<string, PositionReplyThread>();
  if (!signoffIds.length) return grouped;
  const result = await dalInstance.query(
    `SELECT t.id AS thread_id, t.attached_id, c.id, c.body, c.original_language, c.created_at, c.updated_at,
            (SELECT f._rev_user FROM forum_comments f
              WHERE f.id = c.id OR f._old_rev_of = c.id
              ORDER BY f._rev_date ASC LIMIT 1) AS author_id
       FROM forum_threads t
       JOIN forum_comments c
         ON c.thread_id = t.id AND c._old_rev_of IS NULL AND c._rev_deleted = false
      WHERE t._old_rev_of IS NULL AND t._rev_deleted = false
        AND t.attached_type = $1 AND t.attached_id = ANY($2)
      ORDER BY c.created_at ASC`,
    [POSITION_ATTACHMENT, signoffIds]
  );
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const signoffId = row.attached_id as string;
    const body = (row.body as Record<string, string> | null) ?? {};
    const language = (row.original_language as string | null) ?? null;
    const createdAt = (row.created_at as Date | null) ?? null;
    const updatedAt = (row.updated_at as Date | null) ?? null;
    const entry = grouped.get(signoffId) ?? { threadId: row.thread_id as string, replies: [] };
    entry.replies.push({
      id: row.id as string,
      threadId: row.thread_id as string,
      authorId: (row.author_id as string | null) ?? null,
      body: (language && body[language]) || Object.values(body)[0] || '',
      bodyLanguage: language,
      createdAt,
      edited: Boolean(createdAt && updatedAt && updatedAt.getTime() - createdAt.getTime() > 1000),
    });
    grouped.set(signoffId, entry);
  }
  return grouped;
};

/**
 * Reply to a position's comment. The first reply starts a forum thread
 * attached to the position, in the proposal's discussion; later replies go
 * into the same thread. The position's author follows the thread, so they
 * are notified like for any forum reply.
 */
export const replyToPosition = async (
  dalInstance: DataAccessLayer,
  { slug, signoffId, body, language }: PositionReplyInput,
  userId: string
): Promise<{ threadId: string; commentId: string; createdThread: boolean }> => {
  const errors = new ValidationCollector('Invalid reply input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(signoffId, 'signoffId', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureNonEmptyString(language, 'language', errors);
  ensureOptionalLanguage(language, 'language', errors);
  if (typeof body !== 'string' || !body.trim()) errors.add('body', 'must not be empty.', 'required');
  errors.throwIfAny();

  if (!(await canSignOffPages(dalInstance, userId))) {
    throw new ForbiddenError('Blocked or unknown users cannot reply to positions.');
  }
  // Replies are forum posts, so they follow the forum's rule: a confirmed
  // email address is needed to post.
  const author = await User.filterWhere({ id: userId }).first();
  if (!author?.emailVerifiedAt) {
    throw new ForbiddenError('Confirm your email address before posting replies.');
  }
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

  const attachment = { type: POSITION_ATTACHMENT, id: signoff.id };
  const existing = await findAttachedForumThread(attachment);
  if (existing) {
    const comment = await createForumComment({ threadId: existing.id, body: body.trim(), language }, userId);
    return { threadId: existing.id, commentId: comment.id, createdThread: false };
  }

  let thread: Awaited<ReturnType<typeof createForumThread>>;
  try {
    thread = await createForumThread(
      {
        category: 'policy',
        pageSlug: page.slug,
        title: `“${excerpt(signoff.comment ?? '', THREAD_TITLE_EXCERPT)}”`,
        body: body.trim(),
        language,
        attachment,
      },
      userId
    );
  } catch (error) {
    if (!(error instanceof ConstraintError) || error.constraint !== 'uq_forum_threads_current_attachment') {
      throw error;
    }
    const winner = await findAttachedForumThread(attachment);
    if (!winner) throw error;
    const comment = await createForumComment({ threadId: winner.id, body: body.trim(), language }, userId);
    return { threadId: winner.id, commentId: comment.id, createdThread: false };
  }
  const commentId = thread.firstCommentId;
  await subscribeUserToForumThread(thread.id, signoff.userId);
  try {
    // A new thread does not notify by itself; this first reply should reach
    // the person whose position it answers.
    await enqueueForumReplyNotification(thread.id, commentId, userId, enqueueNotificationJob);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`Failed to enqueue the first position reply notification for ${thread.id}: ${message}`);
  }
  try {
    await notifyPageFollowersOfForumPost(
      dalInstance,
      { threadId: thread.id, commentId, actorUserId: userId, event: 'comment' },
      enqueueNotificationJob
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`Failed to notify page followers of the first position reply in ${thread.id}: ${message}`);
  }
  return { threadId: thread.id, commentId, createdThread: true };
};
