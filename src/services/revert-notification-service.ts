import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { escapeHtml } from '../lib/html.js';
import User from '../models/user.js';
import { sendMail } from './email-service.js';
import { deliverNotification, loadNotificationRecipients } from './notification-delivery-service.js';
import type { NotificationJobRecord } from './notification-queue.js';
import { findCurrentPageById } from './page-lookup-service.js';
import type { PageRevertedPayload } from './page-revert-service.js';
import { getSiteBaseUrl } from './site-config.js';

export const PAGE_REVERT_NOTIFICATION_KIND = 'page.revert';

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

  const recipients = await loadNotificationRecipients(payload.recipientUserIds, PAGE_REVERT_NOTIFICATION_KIND);
  const diffUrl = `${getSiteBaseUrl()}${diffPath}`;
  const settingsUrl = `${getSiteBaseUrl()}/tool/settings`;
  return deliverNotification(dal, job.id, recipients, {
    kind: PAGE_REVERT_NOTIFICATION_KIND,
    actorUserId: payload.actorUserId,
    url: diffPath,
    subject: pageTitle,
    excerpt: payload.reason || null,
  }, user => ({
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
  }), sendMailFn);
};
