import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import striptags from 'striptags';
import { forumThreadPath } from '../lib/forum-paths.js';
import { escapeHtml } from '../lib/html.js';
import { collapseWhitespace, EXCERPT_LENGTH, truncate } from '../lib/notification-text.js';
import ForumComment from '../models/forum-comment.js';
import ForumThread from '../models/forum-thread.js';
import User from '../models/user.js';
import { sendMail } from './email-service.js';
import { listActiveForumThreadSubscriberUserIds, subscribeUserToForumThread } from './forum-subscription-service.js';
import { deliverNotification, loadNotificationRecipients } from './notification-delivery-service.js';
import type { NotificationJobRecord } from './notification-queue.js';
import { markdownToPlainText } from './notification-text.js';
import { getSiteBaseUrl } from './site-config.js';

export const FORUM_REPLY_CREATED_NOTIFICATION = 'forum.reply.created';
const FORUM_NOTIFICATION_KIND = 'forum.reply';

export type ForumReplyCreatedPayload = {
  threadId: string;
  commentId: string;
  actorUserId: string;
  recipientUserIds?: string[];
};

const buildCommentPath = (threadId: string, commentId: string) =>
  `${forumThreadPath(threadId)}#comment-${encodeURIComponent(commentId)}`;
const buildCommentUrl = (threadId: string, commentId: string) =>
  `${getSiteBaseUrl()}${buildCommentPath(threadId, commentId)}`;

export const enqueueForumReplyNotification = async (
  threadId: string,
  commentId: string,
  actorUserId: string,
  enqueueJob: (type: string, payload: ForumReplyCreatedPayload) => Promise<unknown>
) => {
  const recipientUserIds = await listForumReplyRecipientUserIds(threadId, actorUserId);
  return enqueueJob(FORUM_REPLY_CREATED_NOTIFICATION, {
    threadId,
    commentId,
    actorUserId,
    recipientUserIds,
  });
};

export const subscribeActorToForumThread = async (threadId: string, userId: string) =>
  subscribeUserToForumThread(threadId, userId);

export const listForumReplyRecipientUserIds = async (
  threadId: string,
  actorUserId: string
) => {
  const subscriberIds = await listActiveForumThreadSubscriberUserIds(threadId);
  return [...new Set(subscriberIds)].filter(userId => userId !== actorUserId);
};

export const listForumReplyNotificationRecipients = (recipientUserIds: string[]) =>
  loadNotificationRecipients(recipientUserIds, FORUM_NOTIFICATION_KIND);

export const processForumReplyCreatedNotification = async (
  dal: DataAccessLayer,
  job: NotificationJobRecord<ForumReplyCreatedPayload>,
  sendMailFn: typeof sendMail = sendMail
) => {
  const payload = job.payload;
  const thread = await ForumThread.filterWhere({
    id: payload.threadId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();
  if (!thread) {
    return { sentCount: 0, skipped: 'thread_not_found' as const };
  }

  const comment = await ForumComment.filterWhere({
    id: payload.commentId,
    threadId: payload.threadId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();
  if (!comment) {
    return { sentCount: 0, skipped: 'comment_not_found' as const };
  }

  const actor = await User.filterWhere({ id: payload.actorUserId }).first();
  const recipientUserIds = Array.isArray(payload.recipientUserIds)
    ? payload.recipientUserIds
    : await listForumReplyRecipientUserIds(payload.threadId, payload.actorUserId);
  const recipients = await listForumReplyNotificationRecipients(recipientUserIds);
  if (recipients.length === 0) return { sentCount: 0, siteCount: 0 };
  const bodySource =
    comment.body?.[comment.originalLanguage ?? 'en']
    ?? Object.values(comment.body ?? {})[0]
    ?? '';
  const excerpt = truncate(await markdownToPlainText(dal, bodySource), EXCERPT_LENGTH);
  const threadTitle = collapseWhitespace(
    striptags(Object.values(thread.title ?? {})[0] ?? thread.id)
  );
  const actorName = actor?.displayName ?? 'Someone';
  const commentUrl = buildCommentUrl(payload.threadId, payload.commentId);
  const settingsUrl = `${getSiteBaseUrl()}/tool/settings`;
  const subject = `New reply in: ${threadTitle}`;
  return deliverNotification(dal, job.id, recipients, {
    kind: FORUM_NOTIFICATION_KIND,
    actorUserId: payload.actorUserId,
    url: buildCommentPath(payload.threadId, payload.commentId),
    subject: threadTitle,
    excerpt,
  }, user => ({
    to: user.email,
    subject,
    text: [
      `${actorName} posted a new reply in "${threadTitle}".`,
      '',
      excerpt,
      '',
      `Open the thread: ${commentUrl}`,
      `Notification settings: ${settingsUrl}`,
    ].join('\n'),
    html: `<p>${escapeHtml(actorName)} posted a new reply in "${escapeHtml(threadTitle)}".</p>
<blockquote>${escapeHtml(excerpt)}</blockquote>
<p><a href="${escapeHtml(commentUrl)}">Open the thread</a></p>
<p><a href="${escapeHtml(settingsUrl)}">Notification settings</a></p>`,
  }), sendMailFn);
};
