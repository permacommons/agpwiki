import assert from 'node:assert/strict';
import test from 'node:test';
import i18next from 'i18next';
import './_setup-i18n.js';
import { renderNotificationBar, renderNotificationList, safeReturnPath } from '../src/routes/lib/notifications.js';
import type { SiteNotification } from '../src/services/site-notification-service.js';

const notification: SiteNotification = {
  id: 'n1',
  kind: 'forum.reply',
  actorUserId: 'u1',
  actorName: '<Erik>',
  url: '/tool/forum/thread/t#comment-c',
  subject: 'Values & <b>wording</b>',
  excerpt: 'A <script>reply</script>',
  createdAt: new Date('2026-10-20T08:00:00Z'),
  readAt: null,
};
const t = i18next.t.bind(i18next);

test('The notification bar names who replied where, escapes everything and offers mark as read', () => {
  const html = renderNotificationBar({ notification, unreadCount: 3, returnTo: '/firefox', t });
  assert.ok(html.includes('<strong>&lt;Erik&gt;</strong> replied in <a href="/tool/notifications/n1/open">Values &amp; &lt;b&gt;wording&lt;/b&gt;</a>'));
  assert.ok(html.includes('2 more'));
  assert.ok(html.includes('name="return" value="/firefox"'));
  assert.ok(html.includes('name="id" value="n1"'));
  assert.ok(!html.includes('<b>'));
});

test('The notification list marks unread items and links to the settings', () => {
  const html = renderNotificationList({ notifications: [notification, { ...notification, id: 'n2', readAt: new Date() }], t });
  assert.equal((html.match(/notification-item--unread/g) ?? []).length, 1);
  assert.ok(html.includes('Mark all as read'));
  assert.ok(html.includes('href="/tool/settings"'));
  assert.ok(html.includes('A &lt;script&gt;reply&lt;/script&gt;'));
  const empty = renderNotificationList({ notifications: [], t });
  assert.ok(empty.includes('No notifications yet'));
  assert.ok(!empty.includes('Mark all as read'));
});

test('Only local paths are accepted to return to', () => {
  assert.equal(safeReturnPath('/firefox?lang=en'), '/firefox?lang=en');
  assert.equal(safeReturnPath('https://evil.example'), '/tool/notifications');
  assert.equal(safeReturnPath('//evil.example'), '/tool/notifications');
  assert.equal(safeReturnPath('/\\evil.example'), '/tool/notifications');
  assert.equal(safeReturnPath(undefined), '/tool/notifications');
});
