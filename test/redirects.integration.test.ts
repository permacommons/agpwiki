import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { initializePostgreSQL } from '../src/db.js';
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import PageAlias from '../src/models/page-alias.js';
import User from '../src/models/user.js';
import { registerBlogRoutes } from '../src/routes/blog.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { createBlogPost, readBlogPost, updateBlogPost } from '../src/services/blog-post-service.js';
import { BLOG_AUTHOR_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { createWikiPage, readWikiPage, updateWikiPage } from '../src/services/wiki-page-service.js';

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | null = null;

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const getDal = async () => {
  sharedDal ??= await initializePostgreSQL();
  return sharedDal;
};

const createTestUser = async () => {
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  return User.create({
    username: `redirecttest${suffix}`,
    displayName: 'Redirect Test',
    email: `redirect-test-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

const startServer = async () => {
  const app = express();
  app.use((req, res, next) => {
    req.t = ((key: string) => key) as typeof req.t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({ canonicalUrl: options?.canonicalUrl ?? null });
    }) as express.Response['render'];
    next();
  });
  registerBlogRoutes(app);
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

const cleanup = async (prefix: string, userId: string | null) => {
  const dal = await getDal();
  await dal.query('DELETE FROM page_aliases WHERE slug LIKE $1 OR page_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
    `${prefix}%`,
  ]);
  await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
  await dal.query('DELETE FROM post_aliases WHERE slug LIKE $1 OR post_id IN (SELECT id FROM posts WHERE slug LIKE $1)', [
    `${prefix}%`,
  ]);
  await dal.query('DELETE FROM posts WHERE slug LIKE $1', [`${prefix}%`]);
  if (userId) {
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

test('Renaming a page keeps its old address as an alias unless asked not to', async () => {
  const dal = await getDal();
  const prefix = `test-redirect-${Date.now()}`;
  let userId: string | null = null;
  const server = await startServer();
  try {
    const user = await createTestUser();
    userId = user.id;
    const page = await createWikiPage(
      dal,
      { slug: `${prefix}-old`, title: { en: 'Old' }, body: { en: 'Text.' } },
      user.id
    );
    await updateWikiPage(
      dal,
      { slug: `${prefix}-old`, newSlug: `${prefix}-new`, revSummary: { en: 'Rename.' } },
      user.id
    );

    const viaOld = await readWikiPage(dal, `${prefix}-old`);
    assert.equal(viaOld.id, page.id);
    assert.equal(viaOld.slug, `${prefix}-new`);

    const redirect = await fetch(`${server.url}/${prefix}-old?lang=en`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), `/${prefix}-new?lang=en`);
    const current = await fetch(`${server.url}/${prefix}-new`);
    assert.equal(current.status, 200);
    const { canonicalUrl } = (await current.json()) as { canonicalUrl: string };
    assert.match(canonicalUrl, new RegExp(`/${prefix}-new$`));

    // Moving the page back onto its own old address releases that alias.
    await updateWikiPage(
      dal,
      { slug: `${prefix}-new`, newSlug: `${prefix}-old`, revSummary: { en: 'Rename back.' } },
      user.id
    );
    assert.equal((await readWikiPage(dal, `${prefix}-new`)).slug, `${prefix}-old`);

    await updateWikiPage(
      dal,
      { slug: `${prefix}-old`, newSlug: `${prefix}-third`, keepAlias: false, revSummary: { en: 'Rename.' } },
      user.id
    );
    await assert.rejects(() => readWikiPage(dal, `${prefix}-old`), NotFoundError);
    // The address released without an alias can be used for another page.
    const other = await createWikiPage(
      dal,
      { slug: `${prefix}-old`, title: { en: 'Other' }, body: { en: 'Text.' } },
      user.id
    );
    await updateWikiPage(
      dal,
      { slug: `${prefix}-old`, newSlug: `${prefix}-other`, revSummary: { en: 'Rename other.' } },
      user.id
    );
    // `-old` is now an alias of the other page, so this page can't take it.
    await assert.rejects(
      () =>
        updateWikiPage(
          dal,
          { slug: `${prefix}-third`, newSlug: `${prefix}-old`, revSummary: { en: 'Onto an alias of another page.' } },
          user.id
        ),
      ConflictError
    );
    assert.equal((await readWikiPage(dal, `${prefix}-old`)).id, other.id);
  } finally {
    await server.close();
    await cleanup(prefix, userId);
  }
});

test('A failed alias creation rolls back the page rename', async t => {
  const dal = await getDal();
  const prefix = `test-redirect-rollback-${Date.now()}-${randomBytes(6).toString('hex')}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const originalSlug = `${prefix}-old`;
    const page = await createWikiPage(
      dal,
      { slug: originalSlug, title: { en: 'Original' }, body: { en: 'Text.' } },
      user.id
    );
    const before = await dal.query('SELECT slug, _rev_id FROM pages WHERE id = $1', [page.id]);
    const failure = new Error('Injected alias creation failure');
    const saveAlias = t.mock.method(PageAlias.prototype, 'save', async () => {
      throw failure;
    });

    await assert.rejects(
      () => updateWikiPage(
        dal,
        { slug: originalSlug, newSlug: `${prefix}-new`, revSummary: { en: 'Rename.' } },
        user.id
      ),
      error => error === failure
    );
    assert.equal(saveAlias.mock.callCount(), 1);

    const after = await dal.query('SELECT slug, _rev_id FROM pages WHERE id = $1', [page.id]);
    assert.deepEqual(after.rows, before.rows, 'a failed rename must preserve the slug and revision');
    const aliases = await dal.query('SELECT id FROM page_aliases WHERE page_id = $1', [page.id]);
    assert.equal(aliases.rows.length, 0);
  } finally {
    await cleanup(prefix, userId);
  }
});

test('A failed alias creation rolls back the blog post rename', async t => {
  const dal = await getDal();
  const prefix = `test-post-rollback-${Date.now()}-${randomBytes(6).toString('hex')}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    await grantRoleUpsert(dal, user.id, BLOG_AUTHOR_ROLE);
    const originalSlug = `${prefix}-old`;
    const post = await createBlogPost(
      dal,
      { slug: originalSlug, title: { en: 'Original' }, body: { en: 'Text.' } },
      user.id
    );
    const before = await dal.query('SELECT slug, _rev_id FROM posts WHERE id = $1', [post.id]);
    const failure = new Error('Injected post alias creation failure');
    const query = dal.query.bind(dal);
    let aliasAttempts = 0;
    t.mock.method(dal, 'query', async (...args) => {
      if (args[0].includes('INSERT INTO post_aliases')) {
        aliasAttempts++;
        throw failure;
      }
      return query(...args);
    });

    await assert.rejects(
      () => updateBlogPost(
        dal,
        { slug: originalSlug, newSlug: `${prefix}-new`, revSummary: { en: 'Rename.' } },
        user.id
      ),
      error => error === failure
    );
    assert.equal(aliasAttempts, 1);
    const after = await dal.query('SELECT slug, _rev_id FROM posts WHERE id = $1', [post.id]);
    assert.deepEqual(after.rows, before.rows, 'a failed rename must preserve the slug and revision');
    const aliases = await dal.query('SELECT id FROM post_aliases WHERE post_id = $1', [post.id]);
    assert.equal(aliases.rows.length, 0);
  } finally {
    await cleanup(prefix, userId);
  }
});

test('Renaming a blog post keeps its old address as an alias', async () => {
  const dal = await getDal();
  const prefix = `test-post-redirect-${Date.now()}`;
  let userId: string | null = null;
  const server = await startServer();
  try {
    const user = await createTestUser();
    userId = user.id;
    await grantRoleUpsert(dal, user.id, BLOG_AUTHOR_ROLE);
    const post = await createBlogPost(
      dal,
      { slug: `${prefix}-old`, title: { en: 'Old' }, body: { en: 'Text.' } },
      user.id
    );
    await updateBlogPost(
      dal,
      { slug: `${prefix}-old`, newSlug: `${prefix}-new`, revSummary: { en: 'Rename.' } },
      user.id
    );

    const viaOld = await readBlogPost(dal, `${prefix}-old`);
    assert.equal(viaOld.id, post.id);
    assert.equal(viaOld.slug, `${prefix}-new`);
    await assert.rejects(
      () => createBlogPost(dal, { slug: `${prefix}-old`, title: { en: 'Taken' }, body: { en: 'Text.' } }, user.id),
      ConflictError
    );

    const redirect = await fetch(`${server.url}/blog/${prefix}-old`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), `/blog/${prefix}-new`);
    const current = await fetch(`${server.url}/blog/${prefix}-new`);
    assert.equal(current.status, 200);
    const { canonicalUrl } = (await current.json()) as { canonicalUrl: string };
    assert.match(canonicalUrl, new RegExp(`/blog/${prefix}-new$`));

    await updateBlogPost(
      dal,
      { slug: `${prefix}-new`, newSlug: `${prefix}-third`, keepAlias: false, revSummary: { en: 'Rename.' } },
      user.id
    );
    await assert.rejects(() => readBlogPost(dal, `${prefix}-new`), NotFoundError);
    assert.equal((await readBlogPost(dal, `${prefix}-old`)).slug, `${prefix}-third`);
  } finally {
    await server.close();
    await cleanup(prefix, userId);
  }
});
