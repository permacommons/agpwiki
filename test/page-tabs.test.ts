import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';
import type { TFunction } from 'i18next';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import User from '../src/models/user.js';
import { renderMarkdown } from '../src/render.js';
import { HISTORY_ANCHOR, renderRevisionHistory } from '../src/routes/lib/history.js';
import { renderPageTabs } from '../src/routes/lib/page-tabs.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { registerToolRoutes } from '../src/routes/tools.js';
import { createForumThread } from '../src/services/forum-service.js';
import { protectWikiPage } from '../src/services/page-protection-service.js';
import { grantRoleUpsert, WIKI_ADMIN_ROLE } from '../src/services/roles.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

const t = ((key: string) => key) as unknown as TFunction;

test('renderPageTabs shows Article, Discuss with its count, Edit and History', () => {
  const html = renderPageTabs({
    isArticle: true,
    pageHref: '/belt-buckle',
    isCurrentView: true,
    discussHref: '/tool/forum/articles/page/belt-buckle',
    discussCount: 3,
    editHref: '/belt-buckle/operator-edit?lang=en',
    t,
  });
  assert.match(html, /^<nav class="page-tabs" aria-label="pageTabs\.label">/);
  assert.match(html, /<a class="page-tab page-tab--current" href="\/belt-buckle" aria-current="page">pageTabs\.article<\/a>/);
  assert.match(html, /href="\/tool\/forum\/articles\/page\/belt-buckle">pageTabs\.discuss <span class="page-tab-count">3<\/span><\/a>/);
  assert.match(html, /<a class="page-tab page-tab--edit" href="\/belt-buckle\/operator-edit\?lang=en">pageTabs\.edit<\/a>/);
  assert.match(html, /href="#wiki:revision-history">pageTabs\.history<\/a>/);
  // Article and Discuss come before the spacer, Edit and History after it.
  assert.ok(html.indexOf('pageTabs.discuss') < html.indexOf('page-tabs-spacer'));
  assert.ok(html.indexOf('page-tabs-spacer') < html.indexOf('pageTabs.edit'));
});

test('revision history has an anchor distinct from Markdown headings', async () => {
  const { html, toc } = await renderMarkdown('## History\n\nText.\n\n## wiki:revision-history', []);
  const historyHtml = renderRevisionHistory({
    revisions: [], action: '/test', viewHref: () => '/test', userMap: new Map(), t,
  });
  assert.match(html, /id="history"/);
  assert.ok(toc.every(item => item.slug !== HISTORY_ANCHOR));
  assert.ok(historyHtml.includes(`<details class="page-history" id="${HISTORY_ANCHOR}">`));
});

test('renderPageTabs on an old revision links back to the page and leaves out Edit', () => {
  const html = renderPageTabs({
    isArticle: false,
    pageHref: '/meta/style',
    isCurrentView: false,
    discussHref: null,
    discussCount: 0,
    editHref: '/meta/style/operator-edit?lang=en',
    t,
  });
  assert.match(html, /<a class="page-tab" href="\/meta\/style">pageTabs\.page<\/a>/);
  assert.doesNotMatch(html, /aria-current/);
  assert.doesNotMatch(html, /pageTabs\.edit/);
  assert.doesNotMatch(html, /pageTabs\.discuss/);
  assert.match(html, /pageTabs\.history/);
});

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

const uniqueSuffix = () => `${Date.now()}-${randomBytes(4).toString('hex')}`;

const createTestUser = async () => {
  const suffix = uniqueSuffix();
  return User.create({
    username: `tabstest${suffix}`,
    displayName: 'Tabs Test',
    email: `tabs-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

const makeServer = async (accountState: Record<string, unknown> | null = null) => {
  const app = express();
  app.use((req, res, next) => {
    (req as express.Request & { t: (key: string, options?: Record<string, unknown>) => string }).t = (
      key,
      options
    ) => (options ? `${key}${JSON.stringify(options)}` : key);
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountState = accountState;
    res.locals.accountBannerHtml = '';
    res.locals.currentPath = req.originalUrl || '/';
    res.render = ((view: string, options?: Record<string, unknown>) => {
      res.json({ view, tabsHtml: options?.tabsHtml ?? '', bodyHtml: options?.bodyHtml ?? '' });
    }) as express.Response['render'];
    next();
  });
  registerToolRoutes(app);
  registerPageRoutes(app);
  const server = http.createServer(app);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('No address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res, rej) => server.close(error => (error ? rej(error) : res()))),
      });
    });
  });
};

const getJson = async (url: string, token?: string) => {
  const response = await fetch(url, { headers: token ? { cookie: `agpwiki_session=${token}` } : {} });
  assert.equal(response.status, 200, url);
  return (await response.json()) as { tabsHtml: string; bodyHtml: string };
};

test('Wiki pages show the tab row; Edit leads editors to the form and everyone else to the help page', async () => {
  const dal = await getDal();
  const slug = `test-tabs-${uniqueSuffix()}`;
  const protectedSlug = `${slug}-protected`;
  const userIds: string[] = [];
  let threadId: string | null = null;
  const server = await makeServer({ isEmailVerified: true, agentAccessStatus: 'approved' });
  try {
    const editor = await createTestUser();
    const admin = await createTestUser();
    userIds.push(editor.id, admin.id);
    await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);
    await createWikiPage(dal, { slug, title: { en: 'Tabs' }, body: { en: 'Text.' }, originalLanguage: 'en' }, editor.id);
    await createWikiPage(
      dal,
      { slug: protectedSlug, title: { en: 'Locked' }, body: { en: 'Text.' }, originalLanguage: 'en' },
      admin.id
    );
    await protectWikiPage(dal, { slug: protectedSlug, reason: 'Test.' }, admin.id);
    const thread = await createForumThread(
      { category: 'articles', pageSlug: slug, title: 'About the tabs', body: 'First.', language: 'en' },
      editor.id
    );
    threadId = thread.id;
    const editorSession = await createSession(editor.id);
    const adminSession = await createSession(admin.id);

    const signedOut = await getJson(`${server.url}/${slug}`);
    assert.match(signedOut.tabsHtml, /aria-current="page">pageTabs\.article</);
    assert.match(signedOut.tabsHtml, /pageTabs\.discuss <span class="page-tab-count">1<\/span>/);
    assert.ok(signedOut.tabsHtml.includes(`href="/tool/how-to-edit?page=${slug}">pageTabs.edit`));

    const signedIn = await getJson(`${server.url}/${slug}`, editorSession.token);
    assert.ok(signedIn.tabsHtml.includes(`href="/${slug}/operator-edit?lang=en">pageTabs.edit`));

    // A protected page sends non-admins to the help page and admins to the form.
    const lockedForEditor = await getJson(`${server.url}/${protectedSlug}`, editorSession.token);
    assert.ok(lockedForEditor.tabsHtml.includes(`href="/tool/how-to-edit?page=${protectedSlug}"`));
    const lockedForAdmin = await getJson(`${server.url}/${protectedSlug}`, adminSession.token);
    assert.ok(lockedForAdmin.tabsHtml.includes(`href="/${protectedSlug}/operator-edit?lang=en"`));

    // An old revision has no Edit tab, and the Article tab is not current.
    const revId = (
      await dal.query('SELECT _rev_id FROM pages WHERE slug = $1 AND _old_rev_of IS NULL', [slug])
    ).rows[0]._rev_id as string;
    const oldRevision = await getJson(`${server.url}/${slug}?rev=${revId}`, editorSession.token);
    assert.doesNotMatch(oldRevision.tabsHtml, /pageTabs\.edit/);
    assert.doesNotMatch(oldRevision.tabsHtml, /aria-current/);
    assert.match(oldRevision.tabsHtml, /pageTabs\.history/);
  } finally {
    await server.close();
    if (threadId) {
      await dal.query('DELETE FROM forum_thread_subscriptions WHERE thread_id = $1', [threadId]);
      await dal.query("DELETE FROM notification_jobs WHERE payload->>'threadId' = $1", [threadId]);
      await dal.query('DELETE FROM forum_comments WHERE thread_id = $1', [threadId]);
      await dal.query('DELETE FROM forum_threads WHERE id = $1 OR _old_rev_of = $1', [threadId]);
    }
    await dal.query('DELETE FROM page_protections WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
      `${slug}%`,
    ]);
    await dal.query('DELETE FROM admin_events WHERE target_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
      `${slug}%`,
    ]);
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${slug}%`]);
    for (const id of userIds) {
      await dal.query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
      await dal.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      await dal.query('DELETE FROM users WHERE id = $1', [id]);
    }
  }
});

test('The how-to-edit page explains the steps, or says who can edit a protected page', async () => {
  const dal = await getDal();
  const slug = `test-how-to-edit-${uniqueSuffix()}`;
  const protectedSlug = `${slug}-protected`;
  const userIds: string[] = [];
  const server = await makeServer();
  try {
    const admin = await createTestUser();
    userIds.push(admin.id);
    await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);
    await createWikiPage(dal, { slug, title: { en: 'Open & shut' }, body: { en: 'Text.' }, originalLanguage: 'en' }, admin.id);
    await createWikiPage(
      dal,
      { slug: protectedSlug, title: { en: 'Locked' }, body: { en: 'Text.' }, originalLanguage: 'en' },
      admin.id
    );
    await protectWikiPage(dal, { slug: protectedSlug, reason: 'Test.' }, admin.id);

    const open = await getJson(`${server.url}/tool/how-to-edit?page=${slug}`);
    // The stub t() JSON-encodes its options, so links passed as options show escaped quotes.
    assert.ok(open.bodyHtml.includes(`howToEdit.intro{"title":"<a href=\\"/${slug}\\">Open & shut</a>"}`));
    assert.match(open.bodyHtml, /<ol class="how-to-edit-steps">/);
    assert.match(open.bodyHtml, /howToEdit\.account/);
    assert.ok(open.bodyHtml.includes('href=\\"/tool/create-account\\"'));
    assert.match(open.bodyHtml, /howToEdit\.approval/);
    assert.match(open.bodyHtml, /howToEdit\.agent <a href="\/meta\/help">howToEdit\.helpLink<\/a>/);
    assert.ok(open.bodyHtml.includes(`/tool/login?redirect=${encodeURIComponent(`/${slug}/operator-edit`)}`));

    const locked = await getJson(`${server.url}/tool/how-to-edit?page=${protectedSlug}`);
    assert.match(locked.bodyHtml, /class="how-to-edit-protected">howToEdit\.protected/);
    assert.doesNotMatch(locked.bodyHtml, /how-to-edit-steps/);

    const missing = await fetch(`${server.url}/tool/how-to-edit?page=${slug}-missing`);
    assert.equal(missing.status, 404);
    const noPage = await fetch(`${server.url}/tool/how-to-edit`);
    assert.equal(noPage.status, 404);
  } finally {
    await server.close();
    await dal.query('DELETE FROM page_protections WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
      `${slug}%`,
    ]);
    await dal.query('DELETE FROM admin_events WHERE target_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
      `${slug}%`,
    ]);
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${slug}%`]);
    for (const id of userIds) {
      await dal.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      await dal.query('DELETE FROM users WHERE id = $1', [id]);
    }
  }
});
