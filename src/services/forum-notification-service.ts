import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import striptags from 'striptags';
import { forumThreadPath } from '../lib/forum-paths.js';
import {
  readNotificationChannel,
  wantsEmailNotification,
  wantsSiteNotification,
} from '../lib/notification-preferences.js';
import ForumComment from '../models/forum-comment.js';
import ForumThread from '../models/forum-thread.js';
import User from '../models/user.js';
import { sendMail } from './email-service.js';
import { listActiveForumThreadSubscriberUserIds, subscribeUserToForumThread } from './forum-subscription-service.js';
import {
  listDeliveredUserIds,
  type NotificationJobRecord,
  recordNotificationDelivery,
} from './notification-queue.js';
import { collapseWhitespace, EXCERPT_LENGTH, escapeHtml, markdownToPlainText, truncate } from './notification-text.js';
import { PAGE_COMMENT_NOTIFICATION, processPageCommentNotification } from './page-comment-notification-service.js';
import { PAGE_REVERTED_NOTIFICATION } from './page-revert-service.js';
import { processPageRevertedNotification } from './revert-notification-service.js';
import { getSiteBaseUrl } from './site-config.js';
import { createSiteNotification } from './site-notification-service.js';

export const FORUM_REPLY_CREATED_NOTIFICATION = 'forum.reply.created';
const FORUM_NOTIFICATION_KIND = 'forum.reply';
const EMAIL_CHANNEL = 'email';
const SITE_CHANNEL = 'site';

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

export const listForumReplyNotificationRecipients = async (
  recipientUserIds: string[]
) => {
  const uniqueIds = [...new Set(recipientUserIds)];
  if (uniqueIds.length === 0) return [];

  const users = await Promise.all(uniqueIds.map(userId => User.filterWhere({ id: userId }).first()));
  return users
    .filter((user): user is NonNullable<typeof user> => Boolean(user && !user.blockedAt))
    .map(user => {
      const channel = readNotificationChannel(user.notificationPreferences, FORUM_NOTIFICATION_KIND);
      return {
        user,
        site: wantsSiteNotification(channel),
        // Email also needs a verified address.
        email: wantsEmailNotification(channel) && Boolean(user.emailVerifiedAt),
      };
    })
    .filter(recipient => recipient.site || recipient.email);
};

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
  const [emailedUserIds, notifiedUserIds] = await Promise.all([
    listDeliveredUserIds(job.id, EMAIL_CHANNEL),
    listDeliveredUserIds(job.id, SITE_CHANNEL),
  ]);
  const siteRecipients = recipients.filter(item => item.site && !notifiedUserIds.has(item.user.id));
  const pendingRecipients = recipients
    .filter(item => item.email && !emailedUserIds.has(item.user.id))
    .map(item => item.user);
  if (pendingRecipients.length === 0 && siteRecipients.length === 0) return { sentCount: 0, siteCount: 0 };

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
  let sentCount = 0;
  let siteCount = 0;

  for (const { user } of siteRecipients) {
    await createSiteNotification(dal, {
      userId: user.id,
      kind: FORUM_NOTIFICATION_KIND,
      actorUserId: payload.actorUserId,
      url: buildCommentPath(payload.threadId, payload.commentId),
      subject: threadTitle,
      excerpt,
      jobId: job.id,
    });
    await recordNotificationDelivery({
      jobId: job.id,
      userId: user.id,
      channel: SITE_CHANNEL,
      status: 'sent',
    });
    siteCount += 1;
  }

  for (const recipient of pendingRecipients) {
    try {
      const delivery = await sendMailFn({
        to: recipient.email,
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
      });
      await recordNotificationDelivery({
        jobId: job.id,
        userId: recipient.id,
        channel: EMAIL_CHANNEL,
        status: delivery.skipped ? 'skipped' : 'sent',
      });
      if (!delivery.skipped) sentCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordNotificationDelivery({
        jobId: job.id,
        userId: recipient.id,
        channel: EMAIL_CHANNEL,
        status: 'failed',
        error: message,
      });
      throw error;
    }
  }

  return { sentCount, siteCount };
};

export const notificationJobHandlers = {
  [FORUM_REPLY_CREATED_NOTIFICATION]: processForumReplyCreatedNotification,
  [PAGE_COMMENT_NOTIFICATION]: processPageCommentNotification,
  [PAGE_REVERTED_NOTIFICATION]: processPageRevertedNotification,
} as const;
