import type { Request, Response } from 'express';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { resolveSessionUser } from '../../auth/session.js';
import type { DiscussionTarget } from '../../lib/discussion-paths.js';
import {
  DISCUSSION_PAGE_SIZE,
  type DiscussionPage,
  type DiscussionScope,
  readDiscussion,
} from '../../services/discussion-service.js';
import { FORUM_MODERATOR_ROLE, userHasRole } from '../../services/roles.js';
import {
  type DiscussionRenderContext,
  type DiscussionViewer,
  discussionCommentsOf,
  listFollowedThreadIds,
  loadDiscussionRenderData,
  type OpenReplyForm,
} from './discussion.js';

/** Who is reading and what they may do, for the threads shown. */
const loadDiscussionViewer = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  threadIds: string[]
): Promise<DiscussionViewer> => {
  const session = await resolveSessionUser(req);
  const userId = session?.userId ?? null;
  return {
    userId,
    canPost: Boolean(userId) &&
      Boolean((res.locals.accountState as { isEmailVerified?: boolean } | null | undefined)?.isEmailVerified),
    isModerator: userId ? await userHasRole(dalInstance, userId, FORUM_MODERATOR_ROLE) : false,
    followedThreadIds: await listFollowedThreadIds(dalInstance, threadIds, userId),
  };
};

/** The rendering context for one page of a discussion. */
export const buildDiscussionContext = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  target: DiscussionTarget,
  discussion: DiscussionPage,
  { headingLevel, openReply }: { headingLevel: 2 | 3; openReply?: OpenReplyForm }
): Promise<DiscussionRenderContext> => {
  const locale = (res.locals.locale as string | undefined) ?? req.language ?? 'en';
  const viewer = await loadDiscussionViewer(
    dalInstance,
    req,
    res,
    discussion.threads.map(thread => thread.id)
  );
  const { bodies, authors } = await loadDiscussionRenderData(dalInstance, discussionCommentsOf(discussion.threads), {
    backToCitationLabel: req.t('citation.backToCitationAria'),
    locale,
  });
  return {
    target,
    t: req.t,
    locale,
    language: req.language ?? 'en',
    languageOptions: res.locals.languageOptions,
    viewer,
    authors,
    bodies,
    headingLevel,
    openReply,
  };
};

export const loadDiscussionPage = async (
  dalInstance: DataAccessLayer,
  req: Request,
  res: Response,
  target: DiscussionTarget,
  scope: DiscussionScope,
  state: { threadId?: string; openReply?: OpenReplyForm } = {}
) => {
  const threadId = state.threadId ?? state.openReply?.threadId ??
    (typeof req.query.thread === 'string' ? req.query.thread : undefined);
  const replyParentId = typeof req.query.reply === 'string' ? req.query.reply : '';
  const parsedPage = typeof req.query.page === 'string' ? Number.parseInt(req.query.page, 10) : Number.NaN;
  const discussion = await readDiscussion(dalInstance, scope, {
    page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    threadId,
    threadIds: typeof req.query.batch === 'string'
      ? req.query.batch.split(',').slice(0, DISCUSSION_PAGE_SIZE)
      : undefined,
  });
  const ctx = await buildDiscussionContext(dalInstance, req, res, target, discussion, {
    headingLevel: 2,
    openReply: state.openReply ?? (threadId && replyParentId ? { threadId, parentId: replyParentId } : undefined),
  });
  ctx.requestedThreadId = threadId;
  return { discussion, ctx };
};
