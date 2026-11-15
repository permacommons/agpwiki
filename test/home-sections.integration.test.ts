import './_use-database.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';
import type { TFunction } from 'i18next';

import { initializePostgreSQL } from '../src/db.js';
import BlogPost from '../src/models/blog-post.js';
import Media from '../src/models/media.js';
import { renderHomeSections } from '../src/routes/lib/home-sections.js';
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
      summary: 'A bell in the header.',
      imageSlug: 'agpedia-notifications-mockup',
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
  issues: { unchecked: 78, 'check-issues': 2, 'no-wikidata': 90 },
  ...overrides,
});

test('renderHomeSections shows cards, posts, discussions and ways to help, each with its button', () => {
  const html = renderHomeSections(sections(), t, 'en');
  assert.match(html, /<a class="home-card" href="\/rooibos">/);
  assert.match(html, /home\.newArticleLabel · Oct 6, 2026/);
  assert.match(html, /Rooibos is a herbal tea\./);
  // A picture only when the article has one.
  assert.equal((html.match(/class="home-thumb"/g) ?? []).length, 1);
  assert.match(html, /src="\/media-files\/gillray-the-gout-1799\/250"/);
  assert.match(html, /<a class="home-post" href="\/blog\/notifications">/);
  assert.match(html, /src="\/media-files\/agpedia-notifications-mockup\/500"/);
  assert.match(
    html,
    /href="\/tool\/forum\/general\?thread=00000000-0000-4000-8000-000000000001#thread"/
  );
  assert.match(html, /forum\.category\.general · Oct 23, 2026/);
  assert.match(html, /home\.waitingForCheck\{&quot;count&quot;:78\}/);
  assert.match(html, /home\.needWikidata\{&quot;count&quot;:90\}/);
  for (const href of ['/tool/pages?sort=new', '/blog', '/tool/forum']) {
    // Each button appears twice: beside the heading and under the section, for phones.
    assert.equal(html.split(`class="home-button" href="${href}"`).length - 1, 2, href);
  }
});

test('blog previews show escaped plain text without Markdown or nested links', () => {
  const data = sections();
  data.posts[0].summary =
    'A **bell** with [notifications](/notifications) & `updates`.[@source] ![Bell](/media/bell){size=250} Second sentence.';
  const html = renderHomeSections(data, t, 'en');
  assert.match(
    html,
    /<span class="home-card-text home-card-text--short">A bell with notifications &amp; updates\. Second sentence\.<\/span>/
  );
  assert.doesNotMatch(html, /href="\/notifications"|\*\*|\[@source\]|!\[Bell\]/);
});

test('blog previews decode entities once and preserve raw HTML as literal text', () => {
  const data = sections();
  data.posts[0].summary = 'Fish &amp; chips &quot;quoted&quot; caf&eacute; &#169; &#x1F41F; &amp;amp; <strong>literal</strong>';
  const html = renderHomeSections(data, t, 'en');
  assert.ok(html.includes('Fish &amp; chips &quot;quoted&quot; café © 🐟 &amp;amp; &lt;strong&gt;literal&lt;/strong&gt;'));
  assert.ok(!html.includes('<strong>literal</strong>'));
});

test('renderHomeSections says so when a section has nothing to show', () => {
  const html = renderHomeSections(sections({ articles: [], posts: [], threads: [] }), t, 'en');
  assert.match(html, /home\.noArticles/);
  assert.match(html, /home\.noPosts/);
  assert.match(html, /home\.noThreads/);
  assert.doesNotMatch(html, /class="home-card"|class="home-post"/);
  assert.match(html, /class="home-help"/);
});

const createTestUser = () => insertTestUser({ prefix: 'hometest', displayName: 'Home Test' });

const makeServer = async () => {
  const app = express();
  app.use((req, res, next) => {
    (req as express.Request & { t: TFunction }).t = t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountState = null;
    res.locals.accountBannerHtml = '';
    res.locals.currentPath = req.originalUrl || '/';
    res.render = ((view: string, options?: Record<string, unknown>) => {
      res.json({ view, bodyHtml: options?.bodyHtml ?? '' });
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

const getBody = async (url: string) => {
  const response = await fetch(url);
  assert.equal(response.status, 200, url);
  return ((await response.json()) as { bodyHtml: string }).bodyHtml;
};

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
        { slug: HOME_PAGE_SLUG, title: { en: 'Welcome' }, body: { en: 'Welcome text.' }, canonicalLanguage: 'en' },
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

    const home = await getBody(`${server.url}/${HOME_PAGE_SLUG}`);
    assert.match(home, /<div class="home-sections">/);
    assert.match(home, /home\.newArticles/);
    // Old versions of the welcome page show only its text.
    const revId = (
      await dal.query('SELECT _rev_id FROM pages WHERE slug = $1 AND _old_rev_of IS NULL', [HOME_PAGE_SLUG])
    ).rows[0]._rev_id as string;
    assert.doesNotMatch(await getBody(`${server.url}/${HOME_PAGE_SLUG}?rev=${revId}`), /home-sections/);
    // Other pages never show them.
    assert.doesNotMatch(await getBody(`${server.url}/${prefix}-newer`), /home-sections/);

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

test('Home posts use current text, summary fallback and only live image references', async () => {
  const dal = await getDal();
  const user = await createTestUser();
  const prefix = `home-post-${randomBytes(8).toString('hex')}`;
  const image = await Media.createFirstRevision({ id: user.id });
  image.slug = prefix;
  image.commonsTitle = 'File:Example.jpg';
  image.mediaType = 'image';
  image.data = {};
  await image.save();
  const post = await BlogPost.createFirstRevision({ id: user.id });
  post.slug = prefix;
  post.title = { en: 'Home post' };
  post.body = { en: 'Old body.' };
  await post.save();
  await post.newRevision({ id: user.id });
  post.body = { en: `Current text. More text. ![Image](/media/${prefix})` };
  await post.save();
  const read = async () => (await loadHomeSections(dal, 'en', { fresh: true })).posts.filter(item => item.slug === prefix);
  let posts = await read();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].summary, 'Current text.');
  assert.equal(posts[0].imageSlug, prefix);
  assert.equal(posts[0].createdAt.getTime(), post.createdAt.getTime());
  await post.newRevision({ id: user.id });
  post.summary = { en: 'Explicit summary.' };
  await post.save();
  await image.deleteAllRevisions({ id: user.id });
  posts = await read();
  assert.equal(posts[0].summary, 'Explicit summary.');
  assert.equal(posts[0].imageSlug, null);
  await post.deleteAllRevisions({ id: user.id });
  assert.deepEqual(await read(), []);
});
