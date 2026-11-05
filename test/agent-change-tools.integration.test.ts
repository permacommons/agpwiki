import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { decodeChangeCursor, encodeChangeCursor } from '../src/lib/change-cursor.js';
import { ValidationError } from '../src/lib/errors.js';
import { createMcpServer } from '../src/mcp/core.js';
import User from '../src/models/user.js';
import { createSiteNotification } from '../src/services/site-notification-service.js';
import { createWikiPage, updateWikiPage } from '../src/services/wiki-page-service.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

let sharedDal: Dal | null = null;
const getDal = async () => {
  sharedDal ??= await initializePostgreSQL();
  return sharedDal;
};
test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const createTestUser = async (name: string) => {
  const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  return User.create({
    username: `changes${name}${suffix}`,
    displayName: `Changes ${name}`,
    email: `changes-${name}-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

type ToolResult = { isError?: boolean; structuredContent: unknown };
type ToolHandlers = Record<
  string,
  { handler: (args: unknown, extra?: { authInfo?: { extra?: { userId?: string } } }) => Promise<ToolResult> }
>;

const getTools = () => (createMcpServer().server as unknown as { _registeredTools: ToolHandlers })._registeredTools;

const call = async <T>(tools: ToolHandlers, name: string, args: unknown, userId: string) => {
  const result = await tools[name].handler(args, { authInfo: { extra: { userId } } });
  assert.equal(result.isError, undefined, `${name} failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent as T;
};

const callError = async (tools: ToolHandlers, name: string, args: unknown, userId: string) => {
  const result = await tools[name].handler(args, { authInfo: { extra: { userId } } });
  assert.equal(result.isError, true, `${name} should fail`);
  return (result.structuredContent as { error: { code: string } }).error;
};

type NotificationList = {
  notifications: Array<{ id: string; subject: string; actor: string | null; read: boolean }>;
  unreadCount: number;
  hasMore: boolean;
  cursor: string;
};

type ChangeList = {
  changes: Array<{ kind: string; slug?: string; title?: string; revId: string; prevRevId: string | null; user: string | null }>;
  hasMore: boolean;
  cursor: string;
};

test('change cursors round-trip and reject anything else', () => {
  const cursor = { time: '2026-11-05T12:00:00.123456Z', id: '0b6c3a42-1f62-4b49-9a0f-3a4f2c1d9e8a' };
  assert.deepEqual(decodeChangeCursor(encodeChangeCursor(cursor)), cursor);
  assert.throws(() => decodeChangeCursor('not-a-cursor'), ValidationError);
  assert.throws(
    () => decodeChangeCursor(Buffer.from('2026-11-05T12:00:00Z|x').toString('base64url')),
    ValidationError
  );
});

test('notifications_list pages through own notifications and notifications_markRead marks them', async () => {
  const dal = await getDal();
  const reader = await createTestUser('reader');
  const actor = await createTestUser('actor');
  const other = await createTestUser('other');
  try {
    const ids: string[] = [];
    for (const subject of ['first', 'second', 'third']) {
      ids.push(
        await createSiteNotification(dal, {
          userId: reader.id,
          kind: 'forum.reply',
          actorUserId: actor.id,
          url: '/meta/test',
          subject,
        })
      );
    }
    const othersId = await createSiteNotification(dal, {
      userId: other.id,
      kind: 'forum.reply',
      url: '/meta/test',
      subject: 'not yours',
    });
    const tools = getTools();

    const first = await call<NotificationList>(tools, 'notifications_list', { limit: 2 }, reader.id);
    assert.deepEqual(
      first.notifications.map(n => n.subject),
      ['first', 'second']
    );
    assert.equal(first.notifications[0].actor, 'Changes actor');
    assert.equal(first.hasMore, true);
    assert.equal(first.unreadCount, 3);

    const second = await call<NotificationList>(tools, 'notifications_list', { cursor: first.cursor }, reader.id);
    assert.deepEqual(
      second.notifications.map(n => n.subject),
      ['third']
    );
    assert.equal(second.hasMore, false);

    const quiet = await call<NotificationList>(tools, 'notifications_list', { cursor: second.cursor }, reader.id);
    assert.deepEqual(quiet.notifications, []);
    assert.equal(quiet.cursor, second.cursor);

    const marked = await call<{ marked: number; unreadCount: number }>(
      tools,
      'notifications_markRead',
      { ids: [ids[0], othersId] },
      reader.id
    );
    assert.deepEqual(marked, { marked: 1, unreadCount: 2 });

    const unread = await call<NotificationList>(tools, 'notifications_list', { unreadOnly: true }, reader.id);
    assert.deepEqual(
      unread.notifications.map(n => n.subject),
      ['second', 'third']
    );
    const all = await call<NotificationList>(tools, 'notifications_list', {}, reader.id);
    assert.deepEqual(
      all.notifications.map(n => [n.subject, n.read]),
      [
        ['first', true],
        ['second', false],
        ['third', false],
      ]
    );

    const otherView = await call<NotificationList>(tools, 'notifications_list', {}, other.id);
    assert.deepEqual(
      otherView.notifications.map(n => n.subject),
      ['not yours']
    );

    assert.equal((await callError(tools, 'notifications_markRead', {}, reader.id)).code, 'validation_error');
    const markedAll = await call<{ marked: number; unreadCount: number }>(
      tools,
      'notifications_markRead',
      { all: true },
      reader.id
    );
    assert.deepEqual(markedAll, { marked: 2, unreadCount: 0 });
  } finally {
    await dal.query('DELETE FROM notifications WHERE user_id = ANY($1)', [[reader.id, other.id]]);
    await dal.query('DELETE FROM users WHERE id = ANY($1)', [[reader.id, actor.id, other.id]]);
  }
});

test('notifications_list excludes all notifications exactly at since', async () => {
  const dal = await getDal();
  const reader = await createTestUser('boundary');
  const since = '2026-01-01T12:00:00.123Z';
  try {
    for (const [subject, time] of [
      ['before', '2026-01-01T12:00:00.122999Z'],
      ['equal one', since],
      ['equal two', since],
      ['after', '2026-01-01T12:00:00.123001Z'],
    ]) {
      const id = await createSiteNotification(dal, {
        userId: reader.id,
        kind: 'forum.reply',
        url: '/meta/test',
        subject,
      });
      await dal.query('UPDATE notifications SET created_at = $1 WHERE id = $2', [time, id]);
    }
    const tools = getTools();
    const result = await call<NotificationList>(tools, 'notifications_list', { since }, reader.id);
    assert.deepEqual(result.notifications.map(n => n.subject), ['after']);

    const empty = await call<NotificationList>(tools, 'notifications_list', { since: '2026-01-01T12:00:01Z' }, reader.id);
    assert.deepEqual(empty.notifications, []);
    const resumed = await call<NotificationList>(tools, 'notifications_list', { cursor: empty.cursor }, reader.id);
    assert.deepEqual(resumed.notifications, []);
  } finally {
    await dal.query('DELETE FROM notifications WHERE user_id = $1', [reader.id]);
    await dal.query('DELETE FROM users WHERE id = $1', [reader.id]);
  }
});

test('changes_since lists page changes after a cursor, by page or address prefix', async () => {
  const dal = await getDal();
  const user = await createTestUser('editor');
  const prefix = `test-changes-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const since = new Date(Date.now() - 1000).toISOString();
  try {
    await createWikiPage(dal, { slug: `${prefix}/a`, title: { en: 'A' }, body: { en: 'One.\n' } }, user.id);
    await createWikiPage(dal, { slug: `${prefix}/b`, title: { en: 'B' }, body: { en: 'Two.\n' } }, user.id);
    await createWikiPage(dal, { slug: `${prefix}-outside`, title: { en: 'C' }, body: { en: 'Three.\n' } }, user.id);
    await updateWikiPage(dal, { slug: `${prefix}/a`, body: { en: 'One, revised.\n' }, revSummary: { en: 'Revise.' } }, user.id);
    const tools = getTools();

    const underPrefix = await call<ChangeList>(tools, 'changes_since', { since, prefix: `${prefix}/` }, user.id);
    assert.deepEqual(
      underPrefix.changes.map(change => [change.kind, change.slug]),
      [
        ['page', `${prefix}/a`],
        ['page', `${prefix}/b`],
        ['page', `${prefix}/a`],
      ]
    );
    assert.equal(underPrefix.changes[0].title, 'A');
    assert.equal(underPrefix.changes[0].user, 'Changes editor');
    assert.equal(underPrefix.changes[0].prevRevId, null);
    assert.equal(underPrefix.changes[2].prevRevId, underPrefix.changes[0].revId);
    assert.equal(underPrefix.hasMore, false);

    const onePage = await call<ChangeList>(tools, 'changes_since', { since, slug: `/${prefix}/a` }, user.id);
    assert.equal(onePage.changes.length, 2);

    const firstPage = await call<ChangeList>(tools, 'changes_since', { since, prefix, limit: 2 }, user.id);
    assert.equal(firstPage.changes.length, 2);
    assert.equal(firstPage.hasMore, true);
    const nextPage = await call<ChangeList>(tools, 'changes_since', { cursor: firstPage.cursor, prefix }, user.id);
    assert.deepEqual(
      nextPage.changes.map(change => change.slug),
      [`${prefix}-outside`, `${prefix}/a`]
    );
    assert.equal(nextPage.hasMore, false);

    const quiet = await call<ChangeList>(tools, 'changes_since', { cursor: nextPage.cursor, prefix }, user.id);
    assert.deepEqual(quiet.changes, []);
    assert.equal(quiet.cursor, nextPage.cursor);

    const citationsOnly = await call<ChangeList>(
      tools,
      'changes_since',
      { since, prefix, kinds: ['citation'] },
      user.id
    );
    assert.deepEqual(citationsOnly.changes, []);

    assert.equal(
      (await callError(tools, 'changes_since', { cursor: 'nope' }, user.id)).code,
      'validation_error'
    );
    assert.equal((await callError(tools, 'changes_since', { since: 'yesterday' }, user.id)).code, 'validation_error');
  } finally {
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
    await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
  }
});
