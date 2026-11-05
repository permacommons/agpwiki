import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { decodeChangeCursor, encodeChangeCursor } from '../src/lib/change-cursor.js';
import { ValidationError } from '../src/lib/errors.js';
import { createMcpServer } from '../src/mcp/core.js';
import Citation from '../src/models/citation.js';
import CitationClaim from '../src/models/citation-claim.js';
import Media from '../src/models/media.js';
import PageCheck from '../src/models/page-check.js';
import User from '../src/models/user.js';
import type { ChangesSinceResult } from '../src/services/change-service.js';
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

type ChangeList = ChangesSinceResult;

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
    await createWikiPage(dal, { slug: `${prefix}/a`, title: { en: `A ${prefix}` }, body: { en: 'One.\n' } }, user.id);
    await createWikiPage(dal, { slug: `${prefix}/b`, title: { en: `B ${prefix}` }, body: { en: 'Two.\n' } }, user.id);
    await createWikiPage(dal, { slug: `${prefix}-outside`, title: { en: `C ${prefix}` }, body: { en: 'Three.\n' } }, user.id);
    await updateWikiPage(dal, { slug: `${prefix}/a`, body: { en: 'One, revised.\n' }, revSummary: { en: 'Revise.' } }, user.id);
    const tools = getTools();

    const underPrefix = await call<ChangeList>(tools, 'changes_since', { since, prefix: `${prefix}/` }, user.id);
    assert.deepEqual(
      underPrefix.changes.map(change => [change.kind, 'slug' in change ? change.slug : undefined]),
      [
        ['page', `${prefix}/a`],
        ['page', `${prefix}/b`],
        ['page', `${prefix}/a`],
      ]
    );
    assert.equal(underPrefix.changes[0].kind, 'page');
    assert.equal(underPrefix.changes[0].title, `A ${prefix}`);
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
      nextPage.changes.map(change => 'slug' in change ? change.slug : undefined),
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

test('changes_since merges every kind and pages through timestamp ties', async () => {
  const dal = await getDal();
  const user = await createTestUser('mixed');
  const suffix = randomBytes(8).toString('hex');
  const slug = `test-mixed-${suffix}`;
  const key = `mixed-${suffix}`;
  try {
    const page = await createWikiPage(dal, { slug, title: { en: `Mixed ${suffix}` }, body: { en: 'Body.' } }, user.id);
    const citation = await Citation.createFirstRevision({ id: user.id });
    Object.assign(citation, { key, data: { type: 'book', title: 'Mixed' } });
    await citation.save();
    const claim = await CitationClaim.createFirstRevision({ id: user.id });
    Object.assign(claim, { citationId: citation.id, claimId: 'example', assertion: { en: 'Claim.' } });
    await claim.save();
    const media = await Media.createFirstRevision({ id: user.id });
    Object.assign(media, { slug, commonsTitle: `File:${suffix}.jpg`, mediaType: 'image', data: {} });
    await media.save();
    const check = await PageCheck.createFirstRevision({ id: user.id });
    Object.assign(check, {
      pageId: page.id,
      type: 'fact_check',
      status: 'completed',
      checkResults: { en: 'Checked.' },
      targetRevId: page.currentRevId,
      metrics: { issues_found: { high: 1, medium: 0, low: 0 }, issues_fixed: { high: 0, medium: 0, low: 0 } },
    });
    await check.save();
    const expected: Array<{ kind: string; revId: string }> = [];
    for (const [table, kind, id] of [
      ['pages', 'page', page.id],
      ['citations', 'citation', citation.id],
      ['citation_claims', 'claim', claim.id],
      ['media', 'media', media.id],
      ['page_checks', 'check', check.id],
    ]) {
      const result = await dal.query(
        `UPDATE ${table} SET _rev_date = '2090-01-01T00:00:00.123456Z' WHERE id = $1 RETURNING _rev_id`, [id]
      );
      expected.push({ kind, revId: result.rows[0]._rev_id as string });
    }
    expected.sort((a, b) => a.revId.localeCompare(b.revId));
    const tools = getTools();
    const received: ChangeList['changes'] = [];
    let args: { since?: string; cursor?: string; limit: number } = { since: '2090-01-01T00:00:00Z', limit: 2 };
    for (let index = 0; index < 3; index++) {
      const result = await call<ChangeList>(tools, 'changes_since', args, user.id);
      assert.equal(result.hasMore, index < 2);
      received.push(...result.changes);
      args = { cursor: result.cursor, limit: 2 };
    }
    assert.deepEqual(received.map(({ kind, revId }) => ({ kind, revId })), expected);
    assert.ok(received.every(change => change.prevRevId === null));
    assert.equal(received.find(change => change.kind === 'page')?.user, 'Changes mixed');
    assert.equal(received.find(change => change.kind === 'page')?.slug, slug);
    assert.equal(received.find(change => change.kind === 'page')?.title, `Mixed ${suffix}`);
    assert.equal(received.find(change => change.kind === 'check')?.slug, slug);
    assert.equal(received.find(change => change.kind === 'check')?.checkStatus, 'completed');
    assert.equal(received.find(change => change.kind === 'check')?.checkType, 'fact_check');
    assert.equal(received.find(change => change.kind === 'citation')?.key, key);
    assert.equal(received.find(change => change.kind === 'claim')?.claimId, 'example');
    assert.equal(received.find(change => change.kind === 'claim')?.key, key);
    assert.equal(received.find(change => change.kind === 'media')?.mediaSlug, slug);
    assert.equal(received.find(change => change.kind === 'media')?.commonsTitle, `File:${suffix}.jpg`);
    for (const change of received) {
      assert.equal('cursor' in change, false);
      assert.equal('revUser' in change, false);
      assert.equal('key' in change, change.kind === 'citation' || change.kind === 'claim');
      assert.equal('slug' in change, change.kind === 'page' || change.kind === 'check');
    }
    const quiet = await call<ChangeList>(tools, 'changes_since', args, user.id);
    assert.deepEqual(quiet.changes, []);
    assert.equal(quiet.cursor, args.cursor);
  } finally {
    await dal.query('DELETE FROM page_checks WHERE page_id IN (SELECT id FROM pages WHERE slug = $1)', [slug]);
    await dal.query('DELETE FROM citation_claims WHERE citation_id IN (SELECT id FROM citations WHERE key = $1)', [key]);
    await dal.query('DELETE FROM citations WHERE key = $1', [key]);
    await dal.query('DELETE FROM media WHERE slug = $1', [slug]);
    await dal.query('DELETE FROM pages WHERE slug = $1', [slug]);
    await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
  }
});
