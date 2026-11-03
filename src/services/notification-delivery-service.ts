import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { type NotificationKind, readNotificationChannel, wantsEmailNotification, wantsSiteNotification } from '../lib/notification-preferences.js';
import User from '../models/user.js';
import { sendMail } from './email-service.js';
import { listDeliveredUserIds, recordNotificationDelivery } from './notification-queue.js';
import { createSiteNotification, type SiteNotificationInput } from './site-notification-service.js';

export const loadNotificationRecipients = async (
  userIds: string[],
  kind: NotificationKind,
  coverage?: { kind: NotificationKind; userIds: string[] }
) => {
  const coveredIds = new Set(coverage?.userIds);
  const users = await Promise.all([...new Set(userIds)].map(id => User.filterWhere({ id }).first()));
  return users
    .filter((user): user is NonNullable<typeof user> => Boolean(user && !user.blockedAt))
    .map(user => {
      const channel = readNotificationChannel(user.notificationPreferences, kind);
      const coveredChannel = coverage && coveredIds.has(user.id)
        ? readNotificationChannel(user.notificationPreferences, coverage.kind)
        : 'none';
      return {
        user,
        site: wantsSiteNotification(channel) && !wantsSiteNotification(coveredChannel),
        email: wantsEmailNotification(channel) && Boolean(user.emailVerifiedAt) && !wantsEmailNotification(coveredChannel),
      };
    })
    .filter(recipient => recipient.site || recipient.email);
};

type Recipient = Awaited<ReturnType<typeof loadNotificationRecipients>>[number];

export const deliverNotification = async (
  dal: DataAccessLayer,
  jobId: string,
  recipients: Recipient[],
  site: Omit<SiteNotificationInput, 'userId' | 'jobId'>,
  email: (user: Recipient['user']) => Parameters<typeof sendMail>[0],
  sendMailFn: typeof sendMail = sendMail
) => {
  const [emailed, notified] = await Promise.all([
    listDeliveredUserIds(jobId, 'email'),
    listDeliveredUserIds(jobId, 'site'),
  ]);
  let siteCount = 0;
  let sentCount = 0;
  for (const { user } of recipients.filter(item => item.site && !notified.has(item.user.id))) {
    await createSiteNotification(dal, { ...site, userId: user.id, jobId });
    await recordNotificationDelivery({ jobId, userId: user.id, channel: 'site', status: 'sent' });
    siteCount += 1;
  }
  for (const { user } of recipients.filter(item => item.email && !emailed.has(item.user.id))) {
    try {
      const delivery = await sendMailFn(email(user));
      await recordNotificationDelivery({ jobId, userId: user.id, channel: 'email', status: delivery.skipped ? 'skipped' : 'sent' });
      if (!delivery.skipped) sentCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordNotificationDelivery({ jobId, userId: user.id, channel: 'email', status: 'failed', error: message });
      throw error;
    }
  }
  return { sentCount, siteCount };
};
