import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import hbs from 'hbs';

import { initializePostgreSQL } from '../src/db.js';
import { createMcpServer } from '../src/mcp/core.js';
import User from '../src/models/user.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { resolvePageSlugOrId } from '../src/services/page-lookup-service.js';
import { grantRoleUpsert, WIKI_ADMIN_ROLE } from '../src/services/roles.js';
import { addWikiPageAlias, createWikiPage, deleteWikiPage, updateWikiPage } from '../src/services/wiki-page-service.js';

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
    username: `permalinktest${suffix}`,
    displayName: 'Permalink Test',
    email: `permalink-test-${suffix}@example.com`,
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
      res.json({ permanentLinkUrl: options?.permanentLinkUrl ?? null });
    }) as express.Response['render'];
    next();
  });
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
  await dal.query(
    'DELETE FROM admin_events WHERE target_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
    [`${prefix}%`]
  );
  await dal.query('DELETE FROM page_aliases WHERE slug LIKE $1 OR page_id IN (SELECT id FROM pages WHERE slug LIKE $1)', [
    `${prefix}%`,
  ]);
  await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
  if (userId) {
    await dal.query('DELETE FROM admin_events WHERE actor_user_id = $1', [userId]);
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

type ToolHandler = (args: unknown) => Promise<{ isError?: boolean; structuredContent: unknown }>;

const getToolHandlers = (server: object) =>
  (server as { _registeredTools: Record<string, { handler: ToolHandler }> })._registeredTools;

test('A permanent link leads to the page under its current address', async () => {
  const dal = await getDal();
  const prefix = `test-permalink-${randomUUID()}`;
  let userId: string | null = null;
  const server = await startServer();
  try {
    const user = await createTestUser();
    userId = user.id;
    const page = await createWikiPage(
      dal,
      { slug: `${prefix}-old`, title: { en: `${prefix} Old` }, body: { en: 'Text.' } },
      user.id
    );

    const reservedSlug = `id/${randomUUID()}`;
    await assert.rejects(
      createWikiPage(dal, { slug: reservedSlug, title: { en: 'Reserved' }, body: { en: 'Text.' } }, user.id),
      /reserved/
    );
    await assert.rejects(
      updateWikiPage(dal, { slug: page.slug, newSlug: reservedSlug, revSummary: { en: 'Rename.' } }, user.id),
      /reserved/
    );
    await assert.rejects(
      addWikiPageAlias(dal, { slug: reservedSlug, pageSlug: page.slug }, user.id),
      /reserved/
    );

    const viewed = await fetch(`${server.url}/${prefix}-old`);
    assert.equal(viewed.status, 200);
    const { permanentLinkUrl } = (await viewed.json()) as { permanentLinkUrl: string };
    assert.match(permanentLinkUrl, new RegExp(`/id/${page.id}$`));

    const first = await fetch(`${server.url}/id/${page.id}`, { redirect: 'manual' });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get('location'), `/${prefix}-old`);

    await updateWikiPage(
      dal,
      { slug: `${prefix}-old`, newSlug: `${prefix}-new`, revSummary: { en: 'Rename.' } },
      user.id
    );
    // The same link follows the rename, keeps the query and takes any case.
    const renamed = await fetch(`${server.url}/id/${page.id.toUpperCase()}?lang=en`, { redirect: 'manual' });
    assert.equal(renamed.status, 302);
    assert.equal(renamed.headers.get('location'), `/${prefix}-new?lang=en`);

    const unknown = await fetch(`${server.url}/id/${randomUUID()}`, { redirect: 'manual' });
    assert.equal(unknown.status, 404);
    // Anything else under /id/ is an ordinary address.
    const notAnId = await fetch(`${server.url}/id/${prefix}`, { redirect: 'manual' });
    assert.equal(notAnId.status, 404);
  } finally {
    await server.close();
    await cleanup(prefix, userId);
  }
});

test('A deleted page answers its permanent link like its old address', async () => {
  const dal = await getDal();
  const prefix = `test-permalink-deleted-${randomUUID()}`;
  let userId: string | null = null;
  const server = await startServer();
  try {
    const user = await createTestUser();
    userId = user.id;
    await grantRoleUpsert(dal, user.id, WIKI_ADMIN_ROLE);
    const page = await createWikiPage(
      dal,
      { slug: prefix, title: { en: `${prefix} Deleted` }, body: { en: 'Text.' } },
      user.id
    );
    await deleteWikiPage(dal, { slug: prefix, revSummary: { en: 'Delete test page.' } }, user.id);

    const viaAddress = await fetch(`${server.url}/${prefix}`, { redirect: 'manual' });
    const viaId = await fetch(`${server.url}/id/${page.id}`, { redirect: 'manual' });
    assert.equal(viaId.status, viaAddress.status);
    assert.equal(await viaId.text(), await viaAddress.text());
    assert.equal(await resolvePageSlugOrId(page.id), page.id);
  } finally {
    await server.close();
    await cleanup(prefix, userId);
  }
});

test('MCP page tools accept a page ID in place of its slug', async () => {
  const dal = await getDal();
  const prefix = `test-permalink-mcp-${randomUUID()}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
    const page = await createWikiPage(
      dal,
      { slug: `${prefix}-old`, title: { en: `${prefix} By ID` }, body: { en: 'Text.' } },
      user.id
    );
    await updateWikiPage(
      dal,
      { slug: `${prefix}-old`, newSlug: `${prefix}-new`, revSummary: { en: 'Rename.' } },
      user.id
    );

    assert.equal(await resolvePageSlugOrId(page.id), `${prefix}-new`);
    assert.equal(await resolvePageSlugOrId(`${prefix}-old`), `${prefix}-old`);

    const tools = getToolHandlers(createMcpServer().server);
    const read = await tools.wiki_readPage.handler({ slug: page.id });
    assert.equal(read.isError, undefined);
    const readPayload = read.structuredContent as { id: string; slug: string };
    assert.equal(readPayload.id, page.id);
    assert.equal(readPayload.slug, `${prefix}-new`);

    const revisions = await tools.wiki_listRevisions.handler({ slug: page.id });
    assert.equal((revisions.structuredContent as { pageId: string }).pageId, page.id);

    const missing = await tools.wiki_readPage.handler({ slug: randomUUID() });
    assert.equal(missing.isError, true);
  } finally {
    await cleanup(prefix, userId);
  }
});

test('The Tools menu offers the permanent link on pages only, without showing the ID', () => {
  const handlebars = hbs.create().handlebars;
  handlebars.registerHelper('__', (key: string) => key);
  handlebars.registerHelper('urlencode', (value: string) => encodeURIComponent(value));
  handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  handlebars.registerHelper('findLanguageLabel', () => '');
  const source = fs.readFileSync(path.resolve(process.cwd(), 'views/partials/header.hbs'), 'utf8');
  const render = handlebars.compile(source);

  const url = 'https://agpedia.org/id/82796d63-a4e1-47d1-9f29-11a703d7dcc9';
  const onPage = render({ permanentLinkUrl: url });
  assert.match(
    onPage,
    /<a\s+class="tools-menu-link tools-menu-link--page"\s+href="https:\/\/agpedia\.org\/id\/82796d63-a4e1-47d1-9f29-11a703d7dcc9"[^>]*data-permanent-link[^>]*data-copied-label="nav\.permanentLinkCopied"\s*>nav\.permanentLink<\/a>/
  );
  // The ID is only in the link's address, never in its text.
  assert.equal(onPage.split('82796d63').length - 1, 1);

  assert.doesNotMatch(render({}), /data-permanent-link/);
});
