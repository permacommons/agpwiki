import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';
import type { TFunction } from 'i18next';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import { readNotificationChannel } from '../src/lib/notification-preferences.js';
import User from '../src/models/user.js';
import { FOLLOW_PATH, registerFollowRoutes } from '../src/routes/follow.js';
import { renderNotificationText } from '../src/routes/lib/notifications.js';
import { renderPageTabs } from '../src/routes/lib/page-tabs.js';
import { createForumComment, createForumThread } from '../src/services/forum-service.js';
import { subscribeUserToForumThread } from '../src/services/forum-subscription-service.js';
import { enqueueNotificationJob } from '../src/services/notification-queue.js';
import {
  notifyPageFollowersOfForumPost,
  PAGE_COMMENT_NOTIFICATION,
  type PageCommentPayload,
  processPageCommentNotification,
} from '../src/services/page-comment-notification-service.js';
import { signOffPage } from '../src/services/page-signoff-service.js';
import {
  followPage,
  isFollowingPage,
  listFollowedPages,
  listPageFollowerUserIds,
  unfollowPage,
} from '../src/services/page-subscription-service.js';
import type { SiteNotification } from '../src/services/site-notification-service.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';

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
    username: `follow${name}${suffix}`,
    displayName: `Follow ${name}`,
    email: `follow-${name}-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
  });
};

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key) as unknown as TFunction;

// Other test files share the notification queue, so jobs are captured here
// instead of queued, and only this file's own queued jobs are removed.
const captureJobs = () => {
  const jobs: PageCommentPayload[] = [];
  return {
    jobs,
    enqueueJob: async (type: string, payload: PageCommentPayload) => {
      assert.equal(type, PAGE_COMMENT_NOTIFICATION);
      jobs.push(payload);
    },
  };
};

const cleanup = async (dal: Dal, prefix: string, userIds: string[]) => {
  const pages = await dal.query('SELECT id FROM pages WHERE slug LIKE $1', [`%${prefix}%`]);
  const pageIds = (pages.rows as Array<{ id: string }>).map(row => row.id);
  const threads = await dal.query("SELECT id FROM forum_threads WHERE title->>'en' LIKE $1", [`%${prefix}%`]);
  const threadIds = (threads.rows as Array<{ id: string }>).map(row => row.id);
  const jobFilter = `payload->>'pageId' = ANY($1) OR payload->>'threadId' = ANY($2)`;
  await dal.query(`DELETE FROM notifications WHERE job_id IN (SELECT id FROM notification_jobs WHERE ${jobFilter})`, [
    pageIds,
    threadIds,
  ]);
  await dal.query(
    `DELETE FROM notification_deliveries WHERE job_id IN (SELECT id FROM notification_jobs WHERE ${jobFilter})`,
    [pageIds, threadIds]
  );
  await dal.query(`DELETE FROM notification_jobs WHERE ${jobFilter}`, [pageIds, threadIds]);
  await dal.query('DELETE FROM notifications WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM forum_thread_subscriptions WHERE thread_id = ANY($1)', [threadIds]);
  await dal.query('DELETE FROM forum_comments WHERE thread_id = ANY($1)', [threadIds]);
  await dal.query('DELETE FROM forum_threads WHERE id = ANY($1) OR _old_rev_of = ANY($1)', [threadIds]);
  await dal.query('DELETE FROM page_signoffs WHERE page_id = ANY($1)', [pageIds]);
  await dal.query('DELETE FROM admin_events WHERE target_id = ANY($1)', [pageIds]);
  await dal.query('DELETE FROM page_subscriptions WHERE page_id = ANY($1) OR user_id = ANY($2)', [pageIds, userIds]);
  await dal.query('DELETE FROM pages WHERE id = ANY($1) OR _old_rev_of = ANY($1)', [pageIds]);
  await dal.query('DELETE FROM auth_sessions WHERE user_id = ANY($1)', [userIds]);
  await dal.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
};

const createPage = (dal: Dal, slug: string, userId: string) =>
  createWikiPage(
    dal,
    { slug, title: { en: `Page ${slug}` }, body: { en: 'Text.' }, originalLanguage: 'en', revSummary: { en: 'Create.' } },
    userId
  );

test('Whoever creates a page follows it; following can be turned off and on', async () => {
  const dal = await getDal();
  const prefix = `follow-own-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const creator = await createTestUser('creator');
    const reader = await createTestUser('reader');
    userIds.push(creator.id, reader.id);
    const page = await createPage(dal, prefix, creator.id);

    assert.deepEqual(await listPageFollowerUserIds(dal, page.id), [creator.id]);
    assert.equal(await isFollowingPage(dal, page.id, reader.id), false);
    await followPage(dal, page.id, reader.id);
    await followPage(dal, page.id, reader.id);
    assert.equal(await isFollowingPage(dal, page.id, reader.id), true);
    assert.deepEqual((await listFollowedPages(dal, reader.id)).map(item => item.slug), [prefix]);
    await unfollowPage(dal, page.id, reader.id);
    assert.deepEqual(await listFollowedPages(dal, reader.id), []);
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

test('Page followers hear about new threads and comments, once, never about their own', async () => {
  const dal = await getDal();
  const prefix = `follow-forum-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const creator = await createTestUser('creator');
    const follower = await createTestUser('follower');
    const commenter = await createTestUser('commenter');
    userIds.push(creator.id, follower.id, commenter.id);
    const page = await createPage(dal, prefix, creator.id);
    await followPage(dal, page.id, follower.id);

    const thread = await createForumThread(
      { category: 'articles', pageSlug: prefix, title: `${prefix} thread`, body: 'First.', language: 'en' },
      commenter.id
    );
    const started = captureJobs();
    await notifyPageFollowersOfForumPost(
      dal,
      { threadId: thread.id, commentId: thread.firstCommentId, actorUserId: commenter.id, event: 'thread' },
      started.enqueueJob
    );
    assert.equal(started.jobs.length, 1);
    assert.equal(started.jobs[0].event, 'thread');
    assert.deepEqual([...(started.jobs[0].recipientUserIds ?? [])].sort(), [creator.id, follower.id].sort());

    // The follower now follows the thread too: they get its forum reply
    // notification, so the page notification leaves them out.
    await subscribeUserToForumThread(thread.id, follower.id);
    const comment = await createForumComment({ threadId: thread.id, body: 'Second.', language: 'en' }, creator.id);
    const commented = captureJobs();
    await notifyPageFollowersOfForumPost(
      dal,
      { threadId: thread.id, commentId: comment.id, actorUserId: creator.id, event: 'comment' },
      commented.enqueueJob
    );
    assert.equal(commented.jobs.length, 0);

    // A thread that is not about a page notifies no page followers.
    const general = await createForumThread(
      { category: 'general', title: `${prefix} general`, body: 'Hello.', language: 'en' },
      commenter.id
    );
    const none = captureJobs();
    await notifyPageFollowersOfForumPost(
      dal,
      { threadId: general.id, commentId: general.firstCommentId, actorUserId: commenter.id, event: 'thread' },
      none.enqueueJob
    );
    assert.equal(none.jobs.length, 0);
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

test('A new or changed position notifies the proposal followers, and processing puts it on the site', async () => {
  const dal = await getDal();
  const suffix = `follow-position-${Date.now()}`;
  const slug = `meta/proposals/${suffix}`;
  const userIds: string[] = [];
  try {
    const creator = await createTestUser('proposer');
    const voter = await createTestUser('voter');
    userIds.push(creator.id, voter.id);
    await createPage(dal, slug, creator.id);

    const first = captureJobs();
    await signOffPage(
      dal,
      { slug, stance: 'oppose', comment: 'Not yet.', commentLanguage: 'en' },
      voter.id,
      { enqueueJob: first.enqueueJob as never }
    );
    assert.equal(first.jobs.length, 1);
    assert.equal(first.jobs[0].event, 'position');
    assert.equal(first.jobs[0].changed, false);
    assert.deepEqual(first.jobs[0].recipientUserIds, [creator.id]);

    const second = captureJobs();
    await signOffPage(dal, { slug, stance: 'support' }, voter.id, { enqueueJob: second.enqueueJob as never });
    assert.equal(second.jobs[0].changed, true);

    // The proposer signing their own proposal notifies nobody.
    const own = captureJobs();
    await signOffPage(dal, { slug, stance: 'support' }, creator.id, { enqueueJob: own.enqueueJob as never });
    assert.equal(own.jobs.length, 0);

    const job = await enqueueNotificationJob(PAGE_COMMENT_NOTIFICATION, second.jobs[0]);
    const sent: string[] = [];
    const result = await processPageCommentNotification(dal, { id: job.id, payload: second.jobs[0] } as never, async message => {
      sent.push(message.to);
      return { delivered: true, skipped: false } as never;
    });
    assert.equal(result.siteCount, 1);
    // Comments on followed pages default to the site only.
    assert.deepEqual(sent, []);
    const rows = await dal.query('SELECT kind, url, subject FROM notifications WHERE user_id = $1', [creator.id]);
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0] as { kind: string; url: string; subject: string };
    assert.equal(row.kind, 'page.position-changed.support');
    assert.match(row.url, new RegExp(`^/meta/proposals/${suffix}#position-`));
    assert.equal(row.subject, `Page ${slug}`);

    // Processing the same job again sends nothing twice.
    const again = await processPageCommentNotification(dal, { id: job.id, payload: second.jobs[0] } as never);
    assert.equal(again.siteCount, 0);
  } finally {
    await cleanup(dal, suffix, userIds);
  }
});

test('Comments on followed pages default to on-site notifications', () => {
  assert.equal(readNotificationChannel({}, 'page.comment'), 'site');
  assert.equal(readNotificationChannel({ 'page.comment': 'both' }, 'page.comment'), 'both');
  assert.equal(readNotificationChannel({}, 'forum.reply'), 'both');
});

test('The tab row shows Follow or Following as a form button next to Discuss', () => {
  const base = {
    isArticle: true,
    pageHref: '/tea',
    isCurrentView: true,
    discussHref: '/tool/forum/articles/page/tea',
    discussCount: 2,
    editHref: '/tea/operator-edit?lang=en',
    t,
  };
  assert.doesNotMatch(renderPageTabs(base), /page-follow/);
  const off = renderPageTabs({ ...base, follow: { slug: 'tea', following: false, returnTo: '/tea', action: FOLLOW_PATH } });
  assert.match(off, /<form class="page-follow-form" method="post" action="\/tool\/follow">/);
  assert.match(off, /name="action" value="follow"/);
  assert.match(off, /aria-pressed="false" title="pageTabs\.followHelp"><span class="page-follow-label">pageTabs\.follow</);
  assert.ok(off.indexOf('pageTabs.discuss') < off.indexOf('page-follow-form'));
  const on = renderPageTabs({ ...base, follow: { slug: 'tea', following: true, returnTo: '/tea', action: FOLLOW_PATH } });
  assert.match(on, /name="action" value="unfollow"/);
  assert.match(on, /class="page-follow page-follow--on" aria-pressed="true"/);
});

test('Notification text names the kind of comment and the stance', () => {
  const base: SiteNotification = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'page.thread',
    actorUserId: null,
    actorName: 'Ana',
    url: '/tea',
    subject: 'Tea',
    excerpt: null,
    createdAt: new Date(),
    readAt: null,
  } as SiteNotification;
  assert.match(renderNotificationText(base, t), /^notifications\.kind\.pageThread/);
  assert.match(renderNotificationText({ ...base, kind: 'page.comment' }, t), /^notifications\.kind\.pageComment/);
  const position = renderNotificationText({ ...base, kind: 'page.position.oppose' }, t);
  assert.match(position, /^notifications\.kind\.pagePosition\{/);
  assert.match(position, /"stance":"signoff\.stance\.oppose"/);
  assert.match(
    renderNotificationText({ ...base, kind: 'page.position-changed.support' }, t),
    /^notifications\.kind\.pagePositionChanged\{/
  );
});

test('POST /tool/follow follows and unfollows for signed-in readers and sends others to log in', async () => {
  const dal = await getDal();
  const prefix = `follow-route-${Date.now()}`;
  const userIds: string[] = [];
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.t = ((key: string) => key) as typeof req.t;
    next();
  });
  registerFollowRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}${FOLLOW_PATH}`;
  const post = (body: Record<string, string>, cookie?: string) =>
    fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(body),
    });
  try {
    const creator = await createTestUser('creator');
    const reader = await createTestUser('reader');
    userIds.push(creator.id, reader.id);
    const page = await createPage(dal, prefix, creator.id);

    const anonymous = await post({ page: prefix, action: 'follow', return: `/${prefix}` });
    assert.equal(anonymous.status, 303);
    assert.match(anonymous.headers.get('location') ?? '', /^\/tool\/login\?redirect=/);

    const session = await createSession(reader.id);
    const cookie = `agpwiki_session=${session.token}`;
    const followed = await post({ page: prefix, action: 'follow', return: `/${prefix}` }, cookie);
    assert.equal(followed.status, 303);
    assert.equal(followed.headers.get('location'), `/${prefix}`);
    assert.equal(await isFollowingPage(dal, page.id, reader.id), true);

    // Return paths never leave the site.
    const unfollowed = await post({ page: prefix, action: 'unfollow', return: '//evil.example' }, cookie);
    assert.equal(unfollowed.headers.get('location'), '/tool/notifications');
    assert.equal(await isFollowingPage(dal, page.id, reader.id), false);

    const missing = await post({ page: `${prefix}-missing`, action: 'follow' }, cookie);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup(dal, prefix, userIds);
  }
});
