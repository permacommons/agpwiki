import type { TFunction } from 'i18next';

import { escapeHtml, formatDateUTC } from '../../render.js';
import type { SiteNotification } from '../../services/site-notification-service.js';

export const NOTIFICATIONS_PATH = '/tool/notifications';
export const notificationOpenPath = (id: string) => `${NOTIFICATIONS_PATH}/${encodeURIComponent(id)}/open`;
export const NOTIFICATIONS_READ_PATH = `${NOTIFICATIONS_PATH}/read`;

/** One line describing a notification, e.g. "Erik replied in Values". */
export const renderNotificationText = (notification: SiteNotification, t: TFunction) => {
  const name = `<strong>${escapeHtml(notification.actorName ?? t('notifications.someone'))}</strong>`;
  const subject = `<a href="${escapeHtml(notificationOpenPath(notification.id))}">${escapeHtml(notification.subject)}</a>`;
  switch (notification.kind) {
    case 'forum.reply':
      return t('notifications.kind.forumReply', { name, subject });
    default:
      return t('notifications.kind.other', { subject });
  }
};

const markReadForm = (t: TFunction, returnTo: string, id?: string) => `<form class="notification-read-form" method="post" action="${NOTIFICATIONS_READ_PATH}">
  ${id ? `<input type="hidden" name="id" value="${escapeHtml(id)}" />` : ''}
  <input type="hidden" name="return" value="${escapeHtml(returnTo)}" />
  <button type="submit">${escapeHtml(t(id ? 'notifications.markRead' : 'notifications.markAllRead'))}</button>
</form>`;

/** The bar under the header with the latest unread notification. */
export const renderNotificationBar = ({
  notification,
  unreadCount,
  returnTo,
  t,
}: {
  notification: SiteNotification;
  unreadCount: number;
  returnTo: string;
  t: TFunction;
}) => {
  const more =
    unreadCount > 1
      ? `<a class="notification-bar-more" href="${NOTIFICATIONS_PATH}">${escapeHtml(
          t('notifications.bar.more', { count: unreadCount - 1 })
        )}</a>`
      : `<a class="notification-bar-more" href="${NOTIFICATIONS_PATH}">${escapeHtml(t('notifications.bar.all'))}</a>`;
  return `<div class="notification-bar" role="status">
  <span class="notification-bar-text">${renderNotificationText(notification, t)}</span>
  ${more}
  ${markReadForm(t, returnTo, notification.id)}
</div>`;
};

export const renderNotificationList = ({
  notifications,
  t,
}: {
  notifications: SiteNotification[];
  t: TFunction;
}) => {
  const hasUnread = notifications.some(item => !item.readAt);
  const items = notifications
    .map(
      item => `<li class="notification-item${item.readAt ? '' : ' notification-item--unread'}">
    <div class="notification-item-text">${renderNotificationText(item, t)}</div>
    ${item.excerpt ? `<p class="notification-item-excerpt" dir="auto">${escapeHtml(item.excerpt)}</p>` : ''}
    <div class="notification-item-meta">${escapeHtml(formatDateUTC(item.createdAt))}${
      item.readAt ? '' : ` · <span class="notification-item-new">${escapeHtml(t('notifications.unread'))}</span>`
    }</div>
  </li>`
    )
    .join('');
  return `<div class="tool-page notifications-page">
  <div class="notifications-actions">
    ${hasUnread ? markReadForm(t, NOTIFICATIONS_PATH) : ''}
    <a href="/tool/settings">${escapeHtml(t('notifications.settings'))}</a>
  </div>
  ${items ? `<ul class="notification-list">${items}</ul>` : `<p class="notification-empty">${escapeHtml(t('notifications.empty'))}</p>`}
</div>`;
};

/** Only local paths are accepted as a place to go back to. */
export const safeReturnPath = (value: unknown) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value
    : NOTIFICATIONS_PATH;
