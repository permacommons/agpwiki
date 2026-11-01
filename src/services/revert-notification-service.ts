import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { readNotificationChannel, wantsEmailNotification, wantsSiteNotification } from '../lib/notification-preferences.js';
import User from '../models/user.js';
import { sendMail } from './email-service.js';
import { listDeliveredUserIds, type NotificationJobRecord, recordNotificationDelivery } from './notification-queue.js';
import type { PageRevertedPayload } from './page-revert-service.js';
import { getSiteBaseUrl } from './site-config.js';
import { createSiteNotification } from './site-notification-service.js';
import { findCurrentPageById } from './wiki-page-service.js';

export const PAGE_REVERT_NOTIFICATION_KIND = 'page.revert';
const EMAIL_CHANNEL = 'email';
const SITE_CHANNEL = 'site';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const slugPath = (slug: string) => `/${slug.split('/').map(encodeURIComponent).join('/')}`;

/** Tells each contributor whose edits were undone, on the channel they chose. */
export const processPageRevertedNotification = async (
  dal: DataAccessLayer,
  job: NotificationJobRecord<PageRevertedPayload>,
  sendMailFn: typeof sendMail = sendMail
) => {
  const payload = job.payload;
  const page = await findCurrentPageById(payload.pageId);
  const slug = page?.slug ?? payload.slug;
  const pageTitle = Object.values(page?.title ?? {})[0] ?? slug;
  // The revert has the same text as the restored version, so the diff that
  // shows what was undone starts from the version the revert replaced.
  const diffFrom = payload.undoneRevId ?? payload.restoredRevId;
  const diffPath = `${slugPath(slug)}?diffFrom=${encodeURIComponent(diffFrom)}&diffTo=${encodeURIComponent(payload.revId)}`;
  const actor = await User.filterWhere({ id: payload.actorUserId }).first();
  const actorName = actor?.displayName ?? 'Someone';

  const [emailed, notified] = await Promise.all([
    listDeliveredUserIds(job.id, EMAIL_CHANNEL),
    listDeliveredUserIds(job.id, SITE_CHANNEL),
  ]);
  let siteCount = 0;
  let sentCount = 0;
  for (const userId of [...new Set(payload.recipientUserIds)]) {
    const user = await User.filterWhere({ id: userId }).first();
    if (!user || user.blockedAt) continue;
    const channel = readNotificationChannel(user.notificationPreferences, PAGE_REVERT_NOTIFICATION_KIND);
    if (wantsSiteNotification(channel) && !notified.has(userId)) {
      await createSiteNotification(dal, {
        userId,
        kind: PAGE_REVERT_NOTIFICATION_KIND,
        actorUserId: payload.actorUserId,
        url: diffPath,
        subject: pageTitle,
        excerpt: payload.reason || null,
        jobId: job.id,
      });
      await recordNotificationDelivery({ jobId: job.id, userId, channel: SITE_CHANNEL, status: 'sent' });
      siteCount += 1;
    }
    if (wantsEmailNotification(channel) && user.emailVerifiedAt && !emailed.has(userId)) {
      const diffUrl = `${getSiteBaseUrl()}${diffPath}`;
      const settingsUrl = `${getSiteBaseUrl()}/tool/settings`;
      const delivery = await sendMailFn({
        to: user.email,
        subject: `Your edits were reverted: ${pageTitle}`,
        text: [
          `${actorName} reverted your edits to "${pageTitle}".`,
          '',
          `Reason: ${payload.reason}`,
          '',
          `See the changes: ${diffUrl}`,
          `Notification settings: ${settingsUrl}`,
        ].join('\n'),
        html: `<p>${escapeHtml(actorName)} reverted your edits to "${escapeHtml(pageTitle)}".</p>
<blockquote>${escapeHtml(payload.reason)}</blockquote>
<p><a href="${escapeHtml(diffUrl)}">See the changes</a></p>
<p><a href="${escapeHtml(settingsUrl)}">Notification settings</a></p>`,
      });
      await recordNotificationDelivery({
        jobId: job.id,
        userId,
        channel: EMAIL_CHANNEL,
        status: delivery.skipped ? 'skipped' : 'sent',
      });
      if (!delivery.skipped) sentCount += 1;
    }
  }
  return { sentCount, siteCount };
};
