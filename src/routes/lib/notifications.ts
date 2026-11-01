import type { TFunction } from 'i18next';

import { escapeHtml, formatDateUTC } from '../../render.js';
import type { SiteNotification } from '../../services/site-notification-service.js';

export const NOTIFICATIONS_PATH = '/tool/notifications';
export const notificationOpenPath = (id: string) => `${NOTIFICATIONS_PATH}/${encodeURIComponent(id)}/open`;
export const NOTIFICATIONS_READ_PATH = `${NOTIFICATIONS_PATH}/read`;
export const NOTIFICATIONS_PANEL_PATH = `${NOTIFICATIONS_PATH}/panel.json`;
export const NOTIFICATIONS_PANEL_LIMIT = 8;

/** One line describing a notification, e.g. "Erik replied in Values". */
export const renderNotificationText = (notification: SiteNotification, t: TFunction) => {
  const name = `<strong>${escapeHtml(notification.actorName ?? t('notifications.someone'))}</strong>`;
  const subject = `<a href="${escapeHtml(notificationOpenPath(notification.id))}">${escapeHtml(notification.subject)}</a>`;
  switch (notification.kind) {
    case 'forum.reply':
      return t('notifications.kind.forumReply', { name, subject });
    case 'page.revert':
      return t('notifications.kind.pageRevert', { name, subject });
    default:
      return t('notifications.kind.other', { subject });
  }
};

const markReadForm = (t: TFunction, returnTo: string, id?: string) => `<form class="notification-read-form" method="post" action="${NOTIFICATIONS_READ_PATH}">
  ${id ? `<input type="hidden" name="id" value="${escapeHtml(id)}" />` : ''}
  <input type="hidden" name="return" value="${escapeHtml(returnTo)}" />
  <button type="submit">${escapeHtml(t(id ? 'notifications.markRead' : 'notifications.markAllRead'))}</button>
</form>`;

export const renderNotificationList = ({
  notifications,
  unreadCount,
  page,
  totalPages,
  t,
}: {
  notifications: SiteNotification[];
  unreadCount: number;
  page: number;
  totalPages: number;
  t: TFunction;
}) => {
  const pagePath = (number: number) => (number === 1 ? NOTIFICATIONS_PATH : `${NOTIFICATIONS_PATH}?page=${number}`);
  const pagination = totalPages > 1
    ? `<div class="history-actions">
  ${page > 1 ? `<a rel="prev" href="${pagePath(page - 1)}">${escapeHtml(t('tool.previous'))}</a>` : ''}
  <span>${escapeHtml(t('tool.pagination', { page, totalPages }))}</span>
  ${page < totalPages ? `<a rel="next" href="${pagePath(page + 1)}">${escapeHtml(t('tool.next'))}</a>` : ''}
</div>`
    : '';
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
    ${unreadCount > 0 ? markReadForm(t, pagePath(page)) : ''}
    <a href="/tool/settings">${escapeHtml(t('notifications.settings'))}</a>
  </div>
  ${pagination}
  ${items ? `<ul class="notification-list">${items}</ul>` : `<p class="notification-empty">${escapeHtml(t('notifications.empty'))}</p>`}
  ${pagination}
</div>`;
};

/** What the bell's panel shows: the latest notifications, newest first. */
export const toNotificationPanelData = (notifications: SiteNotification[], unreadCount: number, t: TFunction) => ({
  unreadCount,
  bellLabel: unreadCount ? t('notifications.bellUnread', { count: unreadCount }) : t('notifications.title'),
  items: notifications.map(item => ({
    id: item.id,
    html: renderNotificationText(item, t),
    excerpt: item.excerpt,
    url: notificationOpenPath(item.id),
    date: formatDateUTC(item.createdAt),
    createdAt: item.createdAt.toISOString(),
    unread: !item.readAt,
  })),
});

/** Only local paths are accepted as a place to go back to. */
export const safeReturnPath = (value: unknown) =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value
    : NOTIFICATIONS_PATH;
