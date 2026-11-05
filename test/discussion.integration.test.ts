import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { initializePostgreSQL } from '../src/db.js';
import { ValidationError } from '../src/lib/errors.js';
import PageAlias from '../src/models/page-alias.js';
import User from '../src/models/user.js';
import { registerDiscussionRoutes } from '../src/routes/discussion.js';
import { registerForumRoutes } from '../src/routes/forum.js';
import { readDiscussion } from '../src/services/discussion-service.js';
import { createForumComment, createForumThread, setForumThreadPinned } from '../src/services/forum-service.js';
import { createBlogPost } from '../src/services/blog-post-service.js';
import { listDiscussedPages } from '../src/services/discussion-service.js';
import { BLOG_AUTHOR_ROLE, FORUM_MODERATOR_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { signOffPage, withdrawPageSignoff } from '../src/services/page-signoff-service.js';
import { replyToPosition } from '../src/services/position-reply-service.js';
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
    username: `disc${name}${suffix}`,
    displayName: `Discussion ${name}`,
    email: `discussion-${name}-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
  });
};

const createPage = (dal: Dal, slug: string, userId: string) =>
  createWikiPage(
    dal,
    { slug, title: { en: `Page ${slug}` }, body: { en: 'Text.' }, canonicalLanguage: 'en', revSummary: { en: 'Create.' } },
    userId
  );

const startThread = (slug: string, title: string, userId: string, category = 'articles') =>
  createForumThread({ category, pageSlug: slug, title, body: `${title}, opening comment.`, language: 'en' }, userId);

const cleanup = async (dal: Dal, prefix: string, userIds: string[]) => {
  const threads = `SELECT id FROM forum_threads WHERE page_slug LIKE $1`;
  await dal.query(`DELETE FROM notification_jobs WHERE payload->>'threadId' IN (SELECT id::text FROM forum_threads WHERE page_slug LIKE $1)`, [`${prefix}%`]);
  await dal.query(`DELETE FROM forum_thread_subscriptions WHERE thread_id IN (${threads})`, [`${prefix}%`]);
  await dal.query(`DELETE FROM forum_comments WHERE thread_id IN (${threads})`, [`${prefix}%`]);
  await dal.query('DELETE FROM forum_threads WHERE page_slug LIKE $1', [`${prefix}%`]);
  await dal.query('DELETE FROM page_aliases WHERE slug LIKE $1', [`${prefix}%`]);
  await dal.query('DELETE FROM page_subscriptions WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [`${prefix}%`]);
  await dal.query('DELETE FROM page_signoffs WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [`${prefix}%`]);
  await dal.query('DELETE FROM admin_events WHERE target_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [`${prefix}%`]);
  await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
  await dal.query('DELETE FROM post_aliases WHERE slug LIKE $1', [`${prefix}%`]);
  await dal.query('DELETE FROM posts WHERE slug LIKE $1', [`${prefix}%`]);
  // Threads in a forum section have no page; their titles carry the prefix.
  const sectionThreads = `SELECT id FROM forum_threads WHERE title->>'en' LIKE $1`;
  await dal.query(`DELETE FROM forum_thread_subscriptions WHERE thread_id IN (${sectionThreads})`, [`${prefix}%`]);
  await dal.query(`DELETE FROM forum_comments WHERE thread_id IN (${sectionThreads})`, [`${prefix}%`]);
  await dal.query(`DELETE FROM forum_threads WHERE title->>'en' LIKE $1`, [`${prefix}%`]);
  for (const userId of userIds) {
    await dal.query('DELETE FROM notification_jobs WHERE payload->>\'actorUserId\' = $1', [userId]);
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

const startServer = async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.t = ((key: string, options?: Record<string, unknown>) =>
      options ? `${key}${JSON.stringify(options)}` : key) as typeof req.t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({
        bodyHtml: options?.bodyHtml ?? null,
        canonicalUrl: options?.canonicalUrl ?? null,
        relNext: options?.relNext ?? null,
        relPrev: options?.relPrev ?? null,
        noindex: options?.noindex ?? null,
      });
    }) as express.Response['render'];
    next();
  });
  registerForumRoutes(app);
  registerDiscussionRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};

test('Replies go one level deep: answering a reply joins the list under its comment', async () => {
  const dal = await getDal();
  const prefix = `disc-depth-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const author = await createTestUser('depth');
    userIds.push(author.id);
    await createPage(dal, prefix, author.id);
    const thread = await startThread(prefix, 'Depth', author.id);
    const reply = await createForumComment(
      { threadId: thread.id, parentId: thread.firstCommentId, body: 'A reply.', language: 'en' },
      author.id
    );
    assert.equal(reply.parentId, thread.firstCommentId);

    const answer = await createForumComment(
      { threadId: thread.id, parentId: reply.id, body: 'An answer to the reply.', language: 'en' },
      author.id
    );
    assert.equal(answer.parentId, thread.firstCommentId, 'joins the list under the top-level comment');

    const other = await startThread(prefix, 'Other', author.id);
    await assert.rejects(
      createForumComment({ threadId: thread.id, parentId: other.firstCommentId, body: 'Wrong thread.', language: 'en' }, author.id),
      ValidationError
    );

    // The database refuses a second level even when the service is bypassed.
    await assert.rejects(
      dal.query('UPDATE forum_comments SET parent_id = $1 WHERE id = $2', [reply.id, answer.id]),
      (error: { code?: string }) => error.code === '23514'
    );
    await assert.rejects(
      dal.query('UPDATE forum_comments SET parent_id = $1 WHERE id = $2', [other.firstCommentId, answer.id]),
      (error: { code?: string }) => error.code === '23514'
    );

    const discussion = await readDiscussion(dal, { pageSlugs: [prefix] });
    const shown = discussion.threads.find(item => item.id === thread.id);
    assert.ok(shown);
    assert.equal(shown.comments.length, 1);
    assert.deepEqual(
      shown.comments[0].replies.map(item => item.id),
      [reply.id, answer.id]
    );
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

test('A discussion lists threads by latest activity, pinned first, paged, with renamed addresses', async () => {
  const dal = await getDal();
  const prefix = `disc-order-${Date.now()}`;
  const userIds: string[] = [];
  try {
    const author = await createTestUser('order');
    const moderator = await createTestUser('moderator');
    userIds.push(author.id, moderator.id);
    await grantRoleUpsert(dal, moderator.id, FORUM_MODERATOR_ROLE);
    const page = await createPage(dal, prefix, author.id);
    const oldest = await startThread(prefix, 'Oldest', author.id);
    const middle = await startThread(prefix, 'Middle', author.id);
    const newest = await startThread(prefix, 'Newest', author.id);
    await createForumComment({ threadId: oldest.id, body: 'Revived.', language: 'en' }, author.id);
    // A thread stored under an older address of the page still belongs to it.
    await PageAlias.create({ pageId: page.id, slug: `${prefix}-old`, createdBy: author.id });
    await dal.query('UPDATE forum_threads SET page_slug = $1 WHERE id = $2', [`${prefix}-old`, middle.id]);
    await setForumThreadPinned(dal, { threadId: middle.id, pinned: true, revSummary: { en: 'Pin.' } }, moderator.id);

    const all = await readDiscussion(dal, { pageSlugs: [prefix, `${prefix}-old`] });
    assert.deepEqual(
      all.threads.map(thread => thread.id),
      [middle.id, oldest.id, newest.id]
    );
    assert.equal(all.threadCount, 3);
    assert.equal(all.commentCount, 4);

    const second = await readDiscussion(dal, { pageSlugs: [prefix, `${prefix}-old`] }, { page: 2, pageSize: 2 });
    assert.deepEqual(second.threads.map(thread => thread.id), [newest.id]);
    assert.equal(second.pageCount, 2);
    const located = await readDiscussion(dal, { pageSlugs: [prefix, `${prefix}-old`] }, { threadId: newest.id, pageSize: 2 });
    assert.equal(located.page, 2);
  } finally {
    await cleanup(dal, prefix, userIds);
  }
});

test('The discussion page shows titled threads with permanent links, and old addresses redirect', async () => {
  const dal = await getDal();
  const prefix = `disc-route-${Date.now()}`;
  const userIds: string[] = [];
  const server = await startServer();
  try {
    const author = await createTestUser('route');
    userIds.push(author.id);
    await createPage(dal, prefix, author.id);
    const thread = await startThread(prefix, 'Plain heading', author.id);
    const reply = await createForumComment(
      { threadId: thread.id, parentId: thread.firstCommentId, body: 'Under it.', language: 'en' },
      author.id
    );

    const response = await fetch(`${server.url}/${prefix}/discussion`);
    assert.equal(response.status, 200);
    const page = (await response.json()) as { bodyHtml: string; canonicalUrl: string; noindex: boolean };
    assert.match(page.canonicalUrl, new RegExp(`/${prefix}/discussion$`));
    assert.equal(page.noindex, false);
    assert.match(page.bodyHtml, /<h2 class="discussion-thread-title"[^>]*>Plain heading<a class="discussion-thread-link"/);
    assert.ok(page.bodyHtml.includes(`href="/${prefix}/discussion?thread=${thread.id}#thread-${thread.id}"`));
    assert.ok(page.bodyHtml.includes(`id="thread-${thread.id}"`));
    assert.ok(page.bodyHtml.includes(`data-replies="${thread.firstCommentId}"><article class="discussion-comment discussion-comment--reply" id="comment-${reply.id}"`));

    const oldThread = await fetch(`${server.url}/tool/forum/thread/${thread.id}`, { redirect: 'manual' });
    assert.equal(oldThread.status, 301);
    assert.equal(oldThread.headers.get('location'), `/${prefix}/discussion?thread=${thread.id}`);

    const oldList = await fetch(`${server.url}/tool/forum/articles/page/${prefix}`, { redirect: 'manual' });
    assert.equal(oldList.status, 301);
    assert.equal(oldList.headers.get('location'), `/${prefix}/discussion`);

    const missing = await fetch(`${server.url}/${prefix}-missing/discussion`);
    assert.equal(missing.status, 404);

    // Without JavaScript, Reply opens the form under the comment.
    const withForm = (await (
      await fetch(`${server.url}/${prefix}/discussion?thread=${thread.id}&reply=${thread.firstCommentId}`)
    ).json()) as { bodyHtml: string };
    assert.ok(!withForm.bodyHtml.includes(`id="reply-form-${thread.firstCommentId}"`), 'signed-out readers get no form');
  } finally {
    await server.close();
    await cleanup(dal, prefix, userIds);
  }
});

test('A long discussion is paged with plain links and canonical addresses', async () => {
  const dal = await getDal();
  const prefix = `disc-pages-${Date.now()}`;
  const userIds: string[] = [];
  const server = await startServer();
  try {
    const author = await createTestUser('pages');
    userIds.push(author.id);
    await createPage(dal, prefix, author.id);
    const threads = [];
    for (let index = 0; index < 21; index += 1) threads.push(await startThread(prefix, `Thread ${index}`, author.id));

    const first = (await (await fetch(`${server.url}/${prefix}/discussion`)).json()) as {
      bodyHtml: string;
      relNext: string | null;
      relPrev: string | null;
    };
    assert.equal(first.relNext, `/${prefix}/discussion?page=2`);
    assert.equal(first.relPrev, null);
    assert.match(first.bodyHtml, /rel="next" data-discussion-next/);

    // The oldest thread is on the second page; its link opens that page.
    const located = (await (await fetch(`${server.url}/${prefix}/discussion?thread=${threads[0].id}`)).json()) as {
      bodyHtml: string;
      canonicalUrl: string;
      relPrev: string | null;
    };
    assert.match(located.canonicalUrl, new RegExp(`/${prefix}/discussion\\?page=2$`));
    assert.equal(located.relPrev, `/${prefix}/discussion`);
    assert.ok(located.bodyHtml.includes(`id="thread-${threads[0].id}"`));
  } finally {
    await server.close();
    await cleanup(dal, prefix, userIds);
  }
});

test('Replies to positions show under the position in the proposal discussion; old thread links redirect', async () => {
  const dal = await getDal();
  const prefix = `meta/proposals/disc-positions-${Date.now()}`;
  const userIds: string[] = [];
  const server = await startServer();
  const noJobs = { enqueueJob: async () => null };
  try {
    const author = await createTestUser('proposer');
    const replier = await createTestUser('replier');
    userIds.push(author.id, replier.id);
    await createPage(dal, prefix, author.id);
    const position = await signOffPage(
      dal,
      { slug: prefix, stance: 'neutral', comment: 'Should renames warn first?', commentLanguage: 'en' },
      author.id,
      noJobs
    );
    const reply = await replyToPosition(
      dal,
      { slug: prefix, signoffId: position.id, body: 'Yes, they should.', language: 'en' },
      replier.id
    );
    const thread = await startThread(prefix, 'A titled thread', author.id, 'policy');

    const page = (await (await fetch(`${server.url}/${prefix}/discussion`)).json()) as { bodyHtml: string };
    assert.ok(page.bodyHtml.includes(`id="position-${position.id}"`));
    assert.ok(
      page.bodyHtml.includes(
        `data-replies="position-${position.id}"><article class="discussion-comment discussion-comment--reply page-signoff-reply" id="comment-${reply.commentId}"`
      )
    );
    assert.ok(page.bodyHtml.includes(`id="thread-${thread.id}"`));
    // The thread holding the replies is not a thread of its own.
    assert.ok(!page.bodyHtml.includes(`id="thread-${reply.threadId}"`));
    assert.ok(!page.bodyHtml.includes('“Should renames warn first?”'));

    const old = await fetch(`${server.url}/tool/forum/thread/${reply.threadId}`, { redirect: 'manual' });
    assert.equal(old.status, 301);
    assert.equal(old.headers.get('location'), `/${prefix}/discussion?position=${position.id}`);

    // A withdrawn position keeps its replies readable.
    await withdrawPageSignoff(dal, { slug: prefix }, author.id);
    const after = (await (await fetch(`${server.url}/${prefix}/discussion`)).json()) as { bodyHtml: string };
    assert.ok(after.bodyHtml.includes('page-signoff--withdrawn'));
    assert.ok(after.bodyHtml.includes(`id="comment-${reply.commentId}"`));
  } finally {
    await server.close();
    await cleanup(dal, prefix, userIds);
  }
});

test('General threads are sections of the General discussion, and their old links redirect', async () => {
  const dal = await getDal();
  const prefix = `disc-general-${Date.now()}`;
  const userIds: string[] = [];
  const server = await startServer();
  try {
    const author = await createTestUser('general');
    userIds.push(author.id);
    const thread = await createForumThread(
      { category: 'general', title: `${prefix} topic`, body: 'Opening.', language: 'en' },
      author.id
    );
    const old = await fetch(`${server.url}/tool/forum/thread/${thread.id}`, { redirect: 'manual' });
    assert.equal(old.status, 301);
    assert.equal(old.headers.get('location'), `/tool/forum/general?thread=${thread.id}`);

    const section = (await (await fetch(`${server.url}/tool/forum/general?thread=${thread.id}`)).json()) as {
      bodyHtml: string;
      canonicalUrl: string;
    };
    assert.ok(section.bodyHtml.includes(`id="thread-${thread.id}"`));
    assert.ok(section.bodyHtml.includes(`href="/tool/forum/general?thread=${thread.id}#thread-${thread.id}"`));
    assert.match(section.canonicalUrl, /\/tool\/forum\/general$/);
  } finally {
    await server.close();
    await cleanup(dal, prefix, userIds);
  }
});

test('A blog post has its own discussion, under the post and at its address plus /discussion', async () => {
  const dal = await getDal();
  const prefix = `disc-blog-${Date.now()}`;
  const userIds: string[] = [];
  const server = await startServer();
  try {
    const author = await createTestUser('blogger');
    userIds.push(author.id);
    await grantRoleUpsert(dal, author.id, BLOG_AUTHOR_ROLE);
    await createBlogPost(dal, { slug: prefix, title: { en: 'A post' }, body: { en: 'Text.' } }, author.id);
    // A wiki page with the same address must not collect the post's threads.
    await createPage(dal, prefix, author.id);

    await assert.rejects(
      createForumThread({ category: 'blog', pageSlug: `${prefix}-missing`, title: 'Lost', body: 'Text.', language: 'en' }, author.id),
      ValidationError
    );
    const thread = await createForumThread(
      { category: 'blog', pageSlug: prefix, title: 'About the post', body: 'A question.', language: 'en' },
      author.id
    );

    const response = await fetch(`${server.url}/blog/${prefix}/discussion`);
    assert.equal(response.status, 200);
    const page = (await response.json()) as { bodyHtml: string; canonicalUrl: string };
    assert.ok(page.bodyHtml.includes(`href="/blog/${prefix}/discussion?thread=${thread.id}#thread-${thread.id}"`));
    assert.match(page.canonicalUrl, new RegExp(`/blog/${prefix}/discussion$`));

    const pageDiscussion = (await (await fetch(`${server.url}/${prefix}/discussion`)).json()) as { bodyHtml: string };
    assert.ok(!pageDiscussion.bodyHtml.includes(`id="thread-${thread.id}"`));

    const old = await fetch(`${server.url}/tool/forum/thread/${thread.id}`, { redirect: 'manual' });
    assert.equal(old.headers.get('location'), `/blog/${prefix}/discussion?thread=${thread.id}`);

    const listed = await listDiscussedPages(dal, 'blog');
    const item = listed.pages.find(entry => entry.slug === prefix);
    assert.ok(item);
    assert.equal(item.threadCount, 1);
    assert.deepEqual(item.title, { en: 'A post' });
  } finally {
    await server.close();
    await cleanup(dal, prefix, userIds);
  }
});
