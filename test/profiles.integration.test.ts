import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import { ForbiddenError, InvalidRequestError } from '../src/lib/errors.js';
import { profilePath, profileSlug } from '../src/lib/profile-paths.js';
import User from '../src/models/user.js';
import { registerDiscussionRoutes } from '../src/routes/discussion.js';
import { registerForumRoutes } from '../src/routes/forum.js';
import { renderRevisionHistory } from '../src/routes/lib/history.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { countPageDiscussionComments, readDiscussion } from '../src/services/discussion-service.js';
import { createForumComment, createForumThread } from '../src/services/forum-service.js';
import { getWikiPageEditability } from '../src/services/page-protection-service.js';
import { loadAccountSummary } from '../src/services/profile-service.js';
import { grantRoleUpsert, WIKI_ADMIN_ROLE } from '../src/services/roles.js';
import { createWikiPage, searchWikiPages, updateWikiPage } from '../src/services/wiki-page-service.js';

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

const createTestUser = async (name: string, displayName = `Profile ${name}`) => {
  const suffix = `${Date.now()}${randomBytes(4).toString('hex')}`;
  return User.create({
    username: `prof${name}${suffix}`,
    displayName,
    email: `profile-${name}-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
  });
};

const writeProfile = (dal: Dal, username: string, userId: string, body = 'I write about printing.') =>
  createWikiPage(
    dal,
    {
      slug: profileSlug(username),
      title: { en: username },
      body: { en: body },
      canonicalLanguage: 'en',
      revSummary: { en: 'About me.' },
    },
    userId
  );

const cleanup = async (dal: Dal, userIds: string[]) => {
  for (const userId of userIds) {
    const slugs = (await dal.query('SELECT username FROM users WHERE id = $1', [userId])).rows.map(
      row => profileSlug(row.username as string)
    );
    for (const slug of slugs) {
      const threads = 'SELECT id FROM forum_threads WHERE page_slug = $1';
      await dal.query(`DELETE FROM notification_jobs WHERE payload->>'threadId' IN (SELECT id::text FROM forum_threads WHERE page_slug = $1)`, [slug]);
      await dal.query(`DELETE FROM forum_thread_subscriptions WHERE thread_id IN (${threads})`, [slug]);
      await dal.query(`DELETE FROM forum_comments WHERE thread_id IN (${threads})`, [slug]);
      await dal.query('DELETE FROM forum_threads WHERE page_slug = $1', [slug]);
      await dal.query('DELETE FROM page_subscriptions WHERE page_id IN (SELECT id FROM pages WHERE slug = $1)', [slug]);
      await dal.query('DELETE FROM pages WHERE slug = $1 OR id IN (SELECT _old_rev_of FROM pages WHERE slug = $1)', [slug]);
    }
  }
  for (const userId of userIds) {
    await dal.query("DELETE FROM notification_jobs WHERE payload->>'actorUserId' = $1", [userId]);
    await dal.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
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
    res.locals.accountState = { isEmailVerified: true };
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({
        title: options?.title ? String(options.title) : null,
        bodyHtml: options?.bodyHtml ?? null,
        tabsHtml: options?.tabsHtml ?? null,
        labelHtml: options?.labelHtml ?? null,
        sidebarHtml: options?.sidebarHtml ?? null,
        noindex: options?.noindex ?? null,
      });
    }) as express.Response['render'];
    next();
  });
  registerForumRoutes(app);
  registerDiscussionRoutes(app);
  registerPageRoutes(app);
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

type Rendered = {
  title: string | null;
  bodyHtml: string;
  tabsHtml: string;
  labelHtml: string;
  sidebarHtml: string | null;
  noindex: boolean | null;
};

test('Only the contributor and wiki admins write a profile, which never moves', async () => {
  const dal = await getDal();
  const userIds: string[] = [];
  try {
    const owner = await createTestUser('owner');
    const other = await createTestUser('other');
    const admin = await createTestUser('admin');
    userIds.push(owner.id, other.id, admin.id);
    await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);

    await assert.rejects(writeProfile(dal, owner.username, other.id), ForbiddenError);
    await assert.rejects(writeProfile(dal, `${owner.username}/notes`, owner.id), InvalidRequestError);
    await assert.rejects(writeProfile(dal, `nobody${owner.username}`, owner.id), InvalidRequestError);

    const page = await writeProfile(dal, owner.username, owner.id);
    const slug = profileSlug(owner.username);
    const edit = (userId: string) =>
      updateWikiPage(dal, { slug, body: { en: `Edited by ${userId}.` }, revSummary: { en: 'Edit.' } }, userId);
    await assert.rejects(edit(other.id), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      assert.equal(error.details?.profileOf, owner.username);
      return true;
    });
    await edit(admin.id);
    await edit(owner.id);
    await assert.rejects(
      updateWikiPage(dal, { slug, newSlug: `${slug}-moved`, revSummary: { en: 'Move.' } }, owner.id),
      InvalidRequestError
    );

    const forOwner = await getWikiPageEditability(dal, { id: page.id }, owner.id);
    assert.deepEqual([forOwner.isEditable, forOwner.profileOf], [true, owner.username]);
    const forOther = await getWikiPageEditability(dal, { id: page.id }, other.id);
    assert.deepEqual([forOther.isProtected, forOther.isEditable], [true, false]);

    // Profiles are not content: two contributors may share a name, and search leaves them out.
    const twin = await createTestUser('twin', owner.displayName);
    userIds.push(twin.id);
    await writeProfile(dal, twin.username, twin.id);
    const results = await searchWikiPages(dal, { query: owner.username });
    assert.equal(results.length, 0);
  } finally {
    await cleanup(dal, userIds);
  }
});

test('A profile shows the account box, and its Talk tab works before the profile has text', async () => {
  const dal = await getDal();
  const userIds: string[] = [];
  const server = await startServer();
  try {
    const owner = await createTestUser('talk', 'Example Editor');
    const visitor = await createTestUser('visitor');
    userIds.push(owner.id, visitor.id);
    const slug = profileSlug(owner.username);

    const empty = (await (await fetch(`${server.url}${profilePath(owner.username)}`)).json()) as Rendered;
    assert.equal(empty.title, 'Example Editor');
    assert.equal(empty.noindex, true);
    assert.ok(empty.labelHtml.includes('profile.label'));
    assert.ok(empty.bodyHtml.includes('profile.empty'));
    assert.ok(empty.tabsHtml.includes(`href="${profilePath(owner.username)}/discussion"`));
    assert.ok(!empty.tabsHtml.includes('operator-edit'), 'Only the contributor gets an Edit tab');
    assert.ok(empty.sidebarHtml?.includes(`<dd>${owner.username}</dd>`));
    assert.ok(empty.sidebarHtml?.includes('profile.account.pagesCreated'));
    assert.equal((await fetch(`${server.url}/user/nobody-${owner.username}`)).status, 404);

    const { token } = await createSession(owner.id);
    const own = (await (
      await fetch(`${server.url}${profilePath(owner.username)}`, { headers: { cookie: `agpwiki_session=${token}` } })
    ).json()) as Rendered;
    assert.ok(own.bodyHtml.includes('profile.emptyOwn'));
    assert.ok(own.tabsHtml.includes(`${profilePath(owner.username)}/operator-edit`));

    const thread = await createForumThread(
      { category: 'users', pageSlug: slug, title: 'A question', body: 'Which source did you use?', language: 'en' },
      visitor.id
    );
    await createForumComment(
      { threadId: thread.id, parentId: thread.firstCommentId, body: 'The 1455 one.', language: 'en' },
      owner.id
    );
    const discussion = await readDiscussion(dal, { pageSlugs: [slug] });
    assert.deepEqual(discussion.threads.map(item => item.id), [thread.id]);
    assert.equal(await countPageDiscussionComments(dal, [slug]), 2);

    // The contributor hears about the new message on their profile.
    const jobs = await dal.query(
      "SELECT payload FROM notification_jobs WHERE payload->>'threadId' = $1 AND payload->>'event' = 'thread'",
      [thread.id]
    );
    const payload = jobs.rows[0]?.payload as { profileUserId?: string; recipientUserIds?: string[] } | undefined;
    assert.equal(payload?.profileUserId, owner.id);
    assert.deepEqual(payload?.recipientUserIds, [owner.id]);

    const talk = (await (await fetch(`${server.url}${profilePath(owner.username)}/discussion`)).json()) as Rendered;
    assert.ok(talk.title?.startsWith('profile.talkTitle'));
    assert.ok(talk.bodyHtml.includes('profile.talkIntro'));
    assert.ok(talk.bodyHtml.includes(`id="comment-${thread.firstCommentId}"`));
    assert.ok(talk.bodyHtml.includes(`href="${profilePath(visitor.username)}"`), 'Authors link to their profiles');
    assert.ok(talk.tabsHtml.includes('page-tab--current'));
    assert.ok(talk.sidebarHtml?.includes('profile-account'));

    const { token: visitorToken } = await createSession(visitor.id);
    const posted = await fetch(`${server.url}${profilePath(owner.username)}/discussion`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: `agpwiki_session=${visitorToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: 'Thanks', body: 'Thank you for the sources.', language: 'en' }).toString(),
    });
    assert.equal(posted.status, 303);
    assert.equal(await countPageDiscussionComments(dal, [slug]), 3);

    // Once written, the profile shows the contributor's text with the same tabs and box.
    await writeProfile(dal, owner.username, owner.id, 'I am a librarian. [My site](https://example.com)');
    const written = (await (await fetch(`${server.url}${profilePath(owner.username)}`)).json()) as Rendered;
    assert.ok(written.bodyHtml.includes('I am a librarian.'));
    assert.ok(written.bodyHtml.includes('rel="nofollow ugc"'));
    assert.ok(!written.bodyHtml.includes('page-discussion'), 'The Talk tab holds the discussion');
    assert.ok(written.sidebarHtml?.includes('profile-account'));
    assert.equal(written.noindex, true);

    const summary = await loadAccountSummary(dal, owner.id);
    assert.equal(summary.edits.pages, 1);
    assert.equal(summary.pagesCreated, 1);
    assert.equal(summary.comments, 1);
  } finally {
    await server.close();
    await cleanup(dal, userIds);
  }
});

test('Histories name each contributor with a link, so the date tooltip names only the agent', () => {
  const html = renderRevisionHistory({
    action: '/page',
    viewHref: revId => `/page?rev=${revId}`,
    userMap: new Map([['u1', 'Example Editor']]),
    usernames: new Map([['u1', 'exampleeditor']]),
    t: ((key: string) => key) as never,
    revisions: [
      {
        revId: 'rev-1',
        dateLabel: '2026-05-19',
        title: 'Page',
        summary: '',
        revUser: 'u1',
        revTags: ['agent:claude.ai', 'agent_version:1.0.0'],
      },
    ],
  });
  assert.ok(html.includes('<a class="user-link" href="/user/exampleeditor">Example Editor</a>'));
  assert.ok(html.includes('title="agent:claude.ai · agent_version:1.0.0"'));
  assert.ok(!html.includes('history.operator'));
});
