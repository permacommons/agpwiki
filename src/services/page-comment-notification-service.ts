import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { forumThreadPath } from '../lib/forum-paths.js';
import {
  readNotificationChannel,
  wantsEmailNotification,
  wantsSiteNotification,
} from '../lib/notification-preferences.js';
import ForumComment from '../models/forum-comment.js';
import ForumThread from '../models/forum-thread.js';
import PageSignoff from '../models/page-signoff.js';
import User from '../models/user.js';
import { sendMail } from './email-service.js';
import { listActiveForumThreadSubscriberUserIds } from './forum-subscription-service.js';
import { listDeliveredUserIds, type NotificationJobRecord, recordNotificationDelivery } from './notification-queue.js';
import {
  collapseWhitespace,
  EXCERPT_LENGTH,
  escapeHtml,
  markdownToPlainText,
  pickLocalizedText,
  truncate,
} from './notification-text.js';
import { findCurrentPageIdBySlug, listPageFollowerUserIds } from './page-subscription-service.js';
import { getSiteBaseUrl } from './site-config.js';
import { createSiteNotification } from './site-notification-service.js';

export const PAGE_COMMENT_NOTIFICATION = 'page.comment.created';
const PAGE_COMMENT_KIND = 'page.comment';
const EMAIL_CHANNEL = 'email';
const SITE_CHANNEL = 'site';

export type PageCommentEvent = 'thread' | 'comment' | 'position';

export type PageCommentPayload = {
  pageId: string;
  event: PageCommentEvent;
  actorUserId: string;
  threadId?: string;
  commentId?: string;
  signoffId?: string;
  // A position that replaces the same person's earlier one.
  changed?: boolean;
  recipientUserIds?: string[];
  forumRecipientUserIds?: string[];
};

type EnqueueJob = (type: string, payload: PageCommentPayload) => Promise<unknown>;

/**
 * Who hears about a comment on a page: the page's followers, minus its author
 * and minus anyone listed in `excludeUserIds`.
 */
export const listPageCommentRecipientUserIds = async (
  dal: DataAccessLayer,
  pageId: string,
  actorUserId: string,
  excludeUserIds: string[] = []
) => {
  const excluded = new Set([actorUserId, ...excludeUserIds]);
  const followers = await listPageFollowerUserIds(dal, pageId);
  return [...new Set(followers)].filter(userId => !excluded.has(userId));
};

const enqueue = async (
  dal: DataAccessLayer,
  payload: Omit<PageCommentPayload, 'recipientUserIds'>,
  excludeUserIds: string[],
  enqueueJob: EnqueueJob
) => {
  const recipientUserIds = await listPageCommentRecipientUserIds(dal, payload.pageId, payload.actorUserId, excludeUserIds);
  if (recipientUserIds.length === 0) return null;
  return enqueueJob(PAGE_COMMENT_NOTIFICATION, { ...payload, recipientUserIds });
};

/**
 * A new thread or a new comment in a thread about a page. Threads that are not
 * about a page notify nobody beyond the thread's own followers.
 */
export const notifyPageFollowersOfForumPost = async (
  dal: DataAccessLayer,
  {
    threadId,
    commentId,
    actorUserId,
    event,
  }: { threadId: string; commentId: string; actorUserId: string; event: 'thread' | 'comment' },
  enqueueJob: EnqueueJob
) => {
  const thread = await ForumThread.filterWhere({ id: threadId, _oldRevOf: null, _revDeleted: false } as Record<
    string,
    unknown
  >).first();
  if (!thread?.pageSlug) return null;
  const pageId = await findCurrentPageIdBySlug(dal, thread.pageSlug);
  if (!pageId) return null;
  const forumRecipientUserIds = event === 'comment' ? await listActiveForumThreadSubscriberUserIds(threadId) : [];
  return enqueue(dal, { pageId, event, actorUserId, threadId, commentId, forumRecipientUserIds }, [], enqueueJob);
};

export const notifyPageFollowersOfPosition = async (
  dal: DataAccessLayer,
  { pageId, signoffId, actorUserId, changed }: { pageId: string; signoffId: string; actorUserId: string; changed: boolean },
  enqueueJob: EnqueueJob
) => enqueue(dal, { pageId, event: 'position', actorUserId, signoffId, changed }, [], enqueueJob);

const loadRecipients = async (recipientUserIds: string[], forumRecipientUserIds: string[]) => {
  const forumRecipients = new Set(forumRecipientUserIds);
  const users = await Promise.all([...new Set(recipientUserIds)].map(userId => User.filterWhere({ id: userId }).first()));
  return users
    .filter((user): user is NonNullable<typeof user> => Boolean(user && !user.blockedAt))
    .map(user => {
      const channel = readNotificationChannel(user.notificationPreferences, PAGE_COMMENT_KIND);
      const forumChannel = forumRecipients.has(user.id)
        ? readNotificationChannel(user.notificationPreferences, 'forum.reply')
        : 'none';
      return {
        user,
        site: wantsSiteNotification(channel) && !wantsSiteNotification(forumChannel),
        email: wantsEmailNotification(channel) && Boolean(user.emailVerifiedAt) && !wantsEmailNotification(forumChannel),
      };
    })
    .filter(recipient => recipient.site || recipient.email);
};

const pagePath = (slug: string) => `/${slug.split('/').map(encodeURIComponent).join('/')}`;

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

interface Rendered {
  // The kind stored with an on-site notification; it picks the sentence shown.
  siteKind: string;
  url: string;
  excerpt: string;
  emailSubject: string;
  emailLead: string;
}

const describe = async (
  dal: DataAccessLayer,
  payload: PageCommentPayload,
  page: { slug: string; title: string },
  actorName: string
): Promise<Rendered | { skipped: string }> => {
  if (payload.event === 'position') {
    const signoff = await PageSignoff.filterWhere({ id: payload.signoffId, withdrawnAt: null } as Record<
      string,
      unknown
    >).first();
    if (!signoff) return { skipped: 'position_not_found' };
    const stance = String(signoff.stance);
    return {
      siteKind: `${payload.changed ? 'page.position-changed' : 'page.position'}.${stance}`,
      url: `${pagePath(page.slug)}#position-${encodeURIComponent(signoff.id)}`,
      excerpt: truncate(collapseWhitespace(signoff.comment ?? ''), EXCERPT_LENGTH),
      emailSubject: `New position on: ${page.title}`,
      emailLead: payload.changed
        ? `${actorName} changed their position on "${page.title}" to ${capitalize(stance)}.`
        : `${actorName} posted a position (${capitalize(stance)}) on "${page.title}".`,
    };
  }

  const comment = await ForumComment.filterWhere({
    id: payload.commentId,
    threadId: payload.threadId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();
  const thread = await ForumThread.filterWhere({ id: payload.threadId, _oldRevOf: null, _revDeleted: false } as Record<
    string,
    unknown
  >).first();
  if (!comment || !thread) return { skipped: 'comment_not_found' };
  const threadTitle = collapseWhitespace(pickLocalizedText(thread.title, thread.originalLanguage));
  const excerpt = truncate(
    await markdownToPlainText(dal, pickLocalizedText(comment.body, comment.originalLanguage)),
    EXCERPT_LENGTH
  );
  const url = `${forumThreadPath(thread.id)}#comment-${encodeURIComponent(comment.id)}`;
  return payload.event === 'thread'
    ? {
        siteKind: 'page.thread',
        url,
        excerpt,
        emailSubject: `New discussion on: ${page.title}`,
        emailLead: `${actorName} started a discussion on "${page.title}": "${threadTitle}".`,
      }
    : {
        siteKind: 'page.comment',
        url,
        excerpt,
        emailSubject: `New comment on: ${page.title}`,
        emailLead: `${actorName} commented on "${page.title}" in "${threadTitle}".`,
      };
};

export const processPageCommentNotification = async (
  dal: DataAccessLayer,
  job: NotificationJobRecord<PageCommentPayload>,
  sendMailFn: typeof sendMail = sendMail
) => {
  const payload = job.payload;
  const pageResult = await dal.query(
    'SELECT slug, title, original_language FROM pages WHERE id = $1 AND _old_rev_of IS NULL AND _rev_deleted = false',
    [payload.pageId]
  );
  const pageRow = pageResult.rows[0] as
    | { slug: string; title: Record<string, string> | null; original_language: string | null }
    | undefined;
  if (!pageRow) return { sentCount: 0, skipped: 'page_not_found' as const };
  const page = {
    slug: pageRow.slug,
    title: collapseWhitespace(pickLocalizedText(pageRow.title, pageRow.original_language)) || pageRow.slug,
  };

  const recipients = await loadRecipients(payload.recipientUserIds ?? [], payload.forumRecipientUserIds ?? []);
  if (recipients.length === 0) return { sentCount: 0, siteCount: 0 };
  const actor = await User.filterWhere({ id: payload.actorUserId }).first();
  const rendered = await describe(dal, payload, page, actor?.displayName ?? 'Someone');
  if ('skipped' in rendered) return { sentCount: 0, siteCount: 0, skipped: rendered.skipped };

  const [emailedUserIds, notifiedUserIds] = await Promise.all([
    listDeliveredUserIds(job.id, EMAIL_CHANNEL),
    listDeliveredUserIds(job.id, SITE_CHANNEL),
  ]);
  let siteCount = 0;
  for (const { user } of recipients.filter(item => item.site && !notifiedUserIds.has(item.user.id))) {
    await createSiteNotification(dal, {
      userId: user.id,
      kind: rendered.siteKind,
      actorUserId: payload.actorUserId,
      url: rendered.url,
      subject: page.title,
      excerpt: rendered.excerpt || null,
      jobId: job.id,
    });
    await recordNotificationDelivery({ jobId: job.id, userId: user.id, channel: SITE_CHANNEL, status: 'sent' });
    siteCount += 1;
  }

  const baseUrl = getSiteBaseUrl();
  const link = `${baseUrl}${rendered.url}`;
  const settingsUrl = `${baseUrl}/tool/settings`;
  let sentCount = 0;
  for (const { user } of recipients.filter(item => item.email && !emailedUserIds.has(item.user.id))) {
    try {
      const delivery = await sendMailFn({
        to: user.email,
        subject: rendered.emailSubject,
        text: [
          rendered.emailLead,
          ...(rendered.excerpt ? ['', rendered.excerpt] : []),
          '',
          `Open it: ${link}`,
          `You follow the comments on this page. To stop, or to change how you are told: ${settingsUrl}`,
        ].join('\n'),
        html: `<p>${escapeHtml(rendered.emailLead)}</p>
${rendered.excerpt ? `<blockquote>${escapeHtml(rendered.excerpt)}</blockquote>\n` : ''}<p><a href="${escapeHtml(link)}">Open it</a></p>
<p>You follow the comments on this page. <a href="${escapeHtml(settingsUrl)}">Stop following, or change how you are told</a></p>`,
      });
      await recordNotificationDelivery({
        jobId: job.id,
        userId: user.id,
        channel: EMAIL_CHANNEL,
        status: delivery.skipped ? 'skipped' : 'sent',
      });
      if (!delivery.skipped) sentCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordNotificationDelivery({ jobId: job.id, userId: user.id, channel: EMAIL_CHANNEL, status: 'failed', error: message });
      throw error;
    }
  }

  return { sentCount, siteCount };
};
