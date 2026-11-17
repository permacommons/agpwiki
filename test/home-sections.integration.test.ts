import './_use-database.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';
import type { TFunction } from 'i18next';

import { createSession } from '../src/auth/session.js';
import { initializePostgreSQL } from '../src/db.js';
import BlogPost from '../src/models/blog-post.js';
import { FOLLOW_PATH, registerFollowRoutes } from '../src/routes/follow.js';
import { type HomePageInput, pickNewArticles, renderHomePage } from '../src/routes/lib/home-sections.js';
import { registerLocaleRoutes } from '../src/routes/locale.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { registerToolRoutes } from '../src/routes/tools.js';
import { createForumThread } from '../src/services/forum-service.js';
import { HOME_PAGE_SLUG, type HomeSections, loadHomeSections } from '../src/services/home-service.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';
import { insertTestUser } from './_test-users.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key) as unknown as TFunction;

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

const sections = (overrides: Partial<HomeSections> = {}): HomeSections => ({
  articles: [
    {
      slug: 'rooibos',
      title: { en: 'Rooibos' },
      createdAt: new Date('2026-10-06T12:00:00Z'),
      excerpt: 'Rooibos is a herbal tea.',
      imageSlug: null,
    },
    {
      slug: 'gout',
      title: { en: 'Gout' },
      createdAt: new Date('2026-09-26T12:00:00Z'),
      excerpt: 'Gout is a form of arthritis.',
      imageSlug: 'gillray-the-gout-1799',
    },
  ],
  posts: [
    {
      slug: 'notifications',
      title: { en: 'Notifications on the site' },
      createdAt: new Date('2026-10-26T12:00:00Z'),
    },
  ],
  threads: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      title: { en: 'Ideas for the wishlist' },
      category: 'general',
      pageSlug: null,
      lastActivityAt: new Date('2026-10-23T12:00:00Z'),
    },
  ],
  proposals: [{ slug: 'meta/proposals/drafts', title: { en: 'Proposal: Draft articles' }, status: 'applied' }],
  issues: { unchecked: 78, 'check-issues': 2, 'no-wikidata': 90 },
  ...overrides,
});

const render = (overrides: Partial<HomeSections> = {}, input: Partial<HomePageInput> = {}) =>
  renderHomePage({
    sections: sections(overrides),
    articleCount: 110,
    welcomeHtml: '<p>Welcome text.</p>',
    editHref: null,
    signedIn: false,
    welcomeLanguageRow: '',
    welcomeHistoryHtml: '',
    welcomeDiscussionHref: null,
    welcomeFollowHtml: '',
    t,
    locale: 'en',
    ...input,
  });

test('The home page leads with the search and the values, then what is new', () => {
  const html = render();
  assert.match(html, /home\.heroTitle/);
  assert.match(html, />home\.heroSubtitle<\/p>/);
  assert.match(html, /home\.searchPlaceholder\{&quot;count&quot;:110\}/);
  assert.match(html, /<form class="home-search" action="\/search" method="get" role="search">/);
  assert.match(html, /<input class="home-search-input" id="home-search-input" type="search" name="q"/);
  for (const key of ['secular', 'truthSeeking', 'methodical', 'agency', 'accountable']) {
    assert.match(html, new RegExp(`home\\.values\\.${key}Name`), key);
  }
  assert.match(html, /href="\/meta\/values"/);
  assert.ok(html.indexOf('home-values') < html.indexOf('home-new'));
  assert.match(html, /<p>Welcome text\.<\/p>/);
  assert.match(html, /href="\/tool\/create-account"/);
  assert.match(html, /home\.waitingForCheck\{&quot;count&quot;:78\}/);
  assert.match(html, /<code class="home-endpoint">http:\/\/127\.0\.0\.1:3000\/mcp<\/code>/);
  assert.match(html, /href="https:\/\/github\.com\/permacommons\/agpwiki"/);
  assert.match(html, /href="\/tool\/forum\/general\?thread=00000000-0000-4000-8000-000000000001#thread"/);
  assert.match(html, /forum\.category\.general · Oct 23, 2026/);
  assert.match(html, /href="\/meta\/proposals\/drafts"/);
  assert.match(html, /proposalStatus\.status\.applied/);
  assert.match(html, /href="\/blog\/notifications"/);
});

test('The featured article is the newest one with a picture; the others are listed', () => {
  const html = render();
  // Rooibos is newer but has no picture, so Gout is featured.
  assert.match(html, /<a class="home-featured" href="\/gout">/);
  assert.match(html, /src="\/media-files\/gillray-the-gout-1799\/500"/);
  assert.match(html, /<li><a href="\/rooibos"><span class="home-list-title">Rooibos<\/span>/);

  const { featured, alsoNew } = pickNewArticles(sections().articles.map(article => ({ ...article, imageSlug: null })));
  assert.equal(featured?.slug, 'rooibos');
  assert.deepEqual(alsoNew.map(article => article.slug), ['gout']);
});

test('Signed-in editors get a link to edit the welcome text and no sign-up button', () => {
  const html = render({}, { signedIn: true, editHref: '/meta/welcome/operator-edit?lang=en' });
  assert.match(html, /href="\/meta\/welcome\/operator-edit\?lang=en">home\.editWelcome/);
  assert.doesNotMatch(html, /href="\/tool\/create-account"/);
  assert.doesNotMatch(render(), /home\.editWelcome/);
});

test('The home page says so when a section has nothing to show', () => {
  const html = render({ articles: [], posts: [], threads: [], proposals: [] });
  for (const key of ['noArticles', 'noPosts', 'noThreads', 'noProposals']) {
    assert.match(html, new RegExp(`home\\.${key}`), key);
  }
  assert.doesNotMatch(html, /class="home-featured"/);
});

const createTestUser = () => insertTestUser({ prefix: 'hometest', displayName: 'Home Test' });

const makeServer = async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    (req as express.Request & { t: TFunction }).t = t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountState = null;
    res.locals.accountBannerHtml = '';
    res.locals.currentPath = req.originalUrl || '/';
    res.render = ((view: string, options?: Record<string, unknown>) => {
      res.json({ view, bodyHtml: options?.bodyHtml ?? '', homeHtml: options?.homeHtml ?? '' });
    }) as express.Response['render'];
    next();
  });
  registerLocaleRoutes(app);
  registerFollowRoutes(app);
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

const getPage = async (url: string, cookie?: string) => {
  const response = await fetch(url, { headers: cookie ? { cookie } : undefined });
  assert.equal(response.status, 200, url);
  return (await response.json()) as { bodyHtml: string; homeHtml: string };
};
const getBody = async (url: string) => (await getPage(url)).bodyHtml;

test('The home page shows the sections below its text, and the page list sorts newest first', async () => {
  const dal = await getDal();
  const prefix = `test-home-${Date.now()}`;
  const server = await makeServer();
  const welcomeExisted =
    ((await dal.query('SELECT 1 FROM pages WHERE slug = $1 AND _old_rev_of IS NULL', [HOME_PAGE_SLUG])).rowCount ?? 0) >
    0;
  try {
    const user = await createTestUser();
    if (!welcomeExisted) {
      await createWikiPage(
        dal,
        {
          slug: HOME_PAGE_SLUG,
          title: { en: 'Welcome', de: 'Willkommen' },
          body: { en: 'Welcome text.', de: 'Willkommen auf der Startseite.' },
          canonicalLanguage: 'en',
        },
        user.id
      );
    }
    await createWikiPage(
      dal,
      { slug: `${prefix}-older`, title: { en: 'Older' }, body: { en: 'Older text.' }, canonicalLanguage: 'en' },
      user.id
    );
    await createWikiPage(
      dal,
      {
        slug: `${prefix}-newer`,
        title: { en: 'Newer' },
        body: { en: 'The newer article is about tea. It has two sentences.' },
        canonicalLanguage: 'en',
      },
      user.id
    );
    const thread = await createForumThread(
      { category: 'general', title: `${prefix} thread`, body: 'First post.', language: 'en' },
      user.id
    );
    const attached = await createForumThread(
      { category: 'general', title: `${prefix} attached`, body: 'A reply.', language: 'en' },
      user.id
    );
    await dal.query(
      "UPDATE forum_threads SET attached_type = 'position', attached_id = gen_random_uuid() WHERE id = $1",
      [attached.id]
    );

    const loaded = await loadHomeSections(dal, 'en', { fresh: true });
    const newer = loaded.articles.find(article => article.slug === `${prefix}-newer`);
    assert.equal(newer?.excerpt, 'The newer article is about tea.');
    assert.ok(loaded.threads.some(item => item.id === thread.id));
    // Threads attached to a position are titled with a quote, so they stay off the home page.
    assert.ok(!loaded.threads.some(item => item.id === attached.id));
    assert.equal(typeof loaded.issues.unchecked, 'number');

    const home = (await getPage(`${server.url}/${HOME_PAGE_SLUG}`)).homeHtml;
    assert.match(home, /class="home-hero"/);
    assert.match(home, /home\.newArticles/);
    assert.match(home, /class="home-how-body"/);
    assert.match(home, /<details class="home-welcome-details">\s*<summary>home\.welcomeDetails<\/summary>[\s\S]*?<details class="page-history"/);
    assert.match(home, /history\.compare/);
    assert.match(home, /class="home-welcome-actions"[\s\S]*?href="\/meta\/welcome\/discussion"/);
    assert.doesNotMatch(home, /class="follow-control-form"/);
    const reader = await createTestUser();
    const session = await createSession(reader.id);
    const cookie = `agpwiki_session=${session.token}`;
    const welcomeUrl = `${server.url}/${HOME_PAGE_SLUG}?lang=en`;
    const returnTo = `/${HOME_PAGE_SLUG}?lang=en#wiki:welcome-tools`;
    const submitFollow = async (action: 'follow' | 'unfollow') => {
      const response = await fetch(server.url + FOLLOW_PATH, {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({ page: HOME_PAGE_SLUG, return: returnTo, action }),
        redirect: 'manual',
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), returnTo);
    };
    assert.match((await getPage(welcomeUrl, cookie)).homeHtml, /class="follow-control" aria-pressed="false"/);
    await submitFollow('follow');
    assert.match((await getPage(welcomeUrl, cookie)).homeHtml, /class="follow-control" aria-pressed="true"/);
    await submitFollow('unfollow');
    assert.match((await getPage(welcomeUrl, cookie)).homeHtml, /class="follow-control" aria-pressed="false"/);
    if (!welcomeExisted) {
      assert.match(home, /<details class="home-welcome-details">[\s\S]*?class="content-language-row"/);
      assert.match(home, /href="\/meta\/welcome\?lang=de#wiki:welcome-tools"[^>]*lang="de" dir="auto">Deutsch/);
      const germanHome = (await getPage(`${server.url}/${HOME_PAGE_SLUG}?lang=de`)).homeHtml;
      assert.match(germanHome, /Willkommen auf der Startseite\./);
      assert.match(germanHome, /href="\/meta\/welcome\?lang=de#wiki:welcome-tools"[^>]*aria-current="true"/);
      assert.match(germanHome, /<input type="hidden" name="lang" value="de">/);
    }
    // Old versions of the welcome page show only its text.
    const revId = (
      await dal.query('SELECT _rev_id FROM pages WHERE slug = $1 AND _old_rev_of IS NULL', [HOME_PAGE_SLUG])
    ).rows[0]._rev_id as string;
    assert.equal((await getPage(`${server.url}/${HOME_PAGE_SLUG}?rev=${revId}`)).homeHtml, '');
    // Other pages never show them.
    assert.equal((await getPage(`${server.url}/${prefix}-newer`)).homeHtml, '');

    const newest = await getBody(`${server.url}/tool/pages?sort=new&per=200`);
    const newerAt = newest.indexOf(`/${prefix}-newer"`);
    assert.ok(newerAt >= 0 && newerAt < newest.indexOf(`/${prefix}-older"`));
    assert.match(newest, /<span class="pages-created">/);
    assert.match(newest, /<strong aria-current="true">tool\.pagesSortNew<\/strong>/);
    const byTitle = await getBody(`${server.url}/tool/pages?per=200`);
    assert.doesNotMatch(byTitle, /pages-created/);
    assert.match(byTitle, /href="\/tool\/pages\?per=200&amp;sort=new">tool\.pagesSortNew/);
  } finally {
    await server.close();
  }
});

test('Switching the interface language clears the current welcome text override', async () => {
  const server = await makeServer();
  try {
    for (const [path, expected] of [
      ['/meta/welcome?lang=de', '/meta/welcome'],
      ['/meta/welcome?rev=123&lang=de', '/meta/welcome?rev=123&lang=de'],
      ['/meta/values?lang=de', '/meta/values?lang=de'],
    ]) {
      const response = await fetch(`${server.url}/set-locale`, {
        method: 'POST',
        headers: { referer: `${server.url}${path}` },
        body: new URLSearchParams({ locale: 'fr' }),
        redirect: 'manual',
      });
      assert.equal(response.status, 302);
      assert.match(response.headers.get('set-cookie') ?? '', /^locale=fr;/);
      assert.equal(new URL(response.headers.get('location') ?? '', server.url).href, `${server.url}${expected}`);
    }
  } finally {
    await server.close();
  }
});

test('Home posts use current titles and original dates and omit deleted posts', async () => {
  const dal = await getDal();
  const user = await createTestUser();
  const prefix = `home-post-${randomBytes(8).toString('hex')}`;
  const post = await BlogPost.createFirstRevision({ id: user.id });
  post.slug = prefix;
  post.title = { en: 'Old title' };
  await post.save();
  await post.newRevision({ id: user.id });
  post.title = { en: 'Current title' };
  await post.save();
  const read = async () => (await loadHomeSections(dal, 'en', { fresh: true })).posts.filter(item => item.slug === prefix);
  assert.deepEqual(await read(), [{ slug: prefix, title: { en: 'Current title' }, createdAt: post.createdAt }]);
  await post.deleteAllRevisions({ id: user.id });
  assert.deepEqual(await read(), []);
});
