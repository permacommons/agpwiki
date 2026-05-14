import { decodeHTML } from 'entities';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import striptags from 'striptags';
import { loadCitationEntriesForSources } from '../lib/citation-render.js';
import { forumThreadPath } from '../lib/forum-paths.js';
import { loadMediaEntriesForSources } from '../lib/media-render.js';
import ForumComment from '../models/forum-comment.js';
import ForumThread from '../models/forum-thread.js';
import User from '../models/user.js';
import { renderMarkdown } from '../render.js';
import { sendMail } from './email-service.js';
import { listActiveForumThreadSubscriberUserIds, subscribeUserToForumThread } from './forum-subscription-service.js';
import {
  listDeliveredUserIds,
  type NotificationJobRecord,
  recordNotificationDelivery,
} from './notification-queue.js';
import { getSiteBaseUrl } from './site-config.js';

export const FORUM_REPLY_CREATED_NOTIFICATION = 'forum.reply.created';
const FORUM_NOTIFICATION_CHANNEL = 'email';
const EXCERPT_LENGTH = 280;

export type ForumReplyCreatedPayload = {
  threadId: string;
  commentId: string;
  actorUserId: string;
  recipientUserIds?: string[];
};

const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const markdownToPlainText = async (dal: DataAccessLayer, markdown: string) => {
  const [citationEntries, mediaRegistry] = await Promise.all([
    loadCitationEntriesForSources(dal, [markdown]),
    loadMediaEntriesForSources(dal, [markdown]),
  ]);
  const rendered = await renderMarkdown(markdown, citationEntries, {
    backToCitationLabel: 'Back to citation',
    mediaRegistry,
  });
  return collapseWhitespace(decodeHTML(striptags(rendered.html)));
};

const truncate = (value: string, maxLength: number) => {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildCommentUrl = (threadId: string, commentId: string) =>
  `${getSiteBaseUrl()}${forumThreadPath(threadId)}#comment-${encodeURIComponent(commentId)}`;

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
  return users.filter(
    (user): user is NonNullable<typeof user> =>
      Boolean(
        user
        && !user.blockedAt
        && user.emailVerifiedAt
        && user.emailNotificationsEnabled !== false
      )
  );
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
  if (recipients.length === 0) return { sentCount: 0 };
  const deliveredUserIds = await listDeliveredUserIds(job.id, FORUM_NOTIFICATION_CHANNEL);
  const pendingRecipients = recipients.filter(recipient => !deliveredUserIds.has(recipient.id));
  if (pendingRecipients.length === 0) return { sentCount: 0 };

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
        channel: FORUM_NOTIFICATION_CHANNEL,
        status: delivery.skipped ? 'skipped' : 'sent',
      });
      if (!delivery.skipped) sentCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordNotificationDelivery({
        jobId: job.id,
        userId: recipient.id,
        channel: FORUM_NOTIFICATION_CHANNEL,
        status: 'failed',
        error: message,
      });
      throw error;
    }
  }

  return { sentCount };
};

export const notificationJobHandlers = {
  [FORUM_REPLY_CREATED_NOTIFICATION]: processForumReplyCreatedNotification,
} as const;
