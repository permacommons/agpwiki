import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { initializePostgreSQL } from '../src/db.js';
import { registerPageRoutes } from '../src/routes/pages.js';
import { setProposalStatus } from '../src/services/proposal-status-service.js';
import { createWikiPage, updateWikiPage } from '../src/services/wiki-page-service.js';
import { insertTestUser } from './_test-users.js';


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

const createTestUser = () => insertTestUser({ prefix: 'robotstest', displayName: 'Robots Test' });

const startServer = async () => {
  const app = express();
  app.use((req, res, next) => {
    req.t = ((key: string) => key) as typeof req.t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({ noindex: options?.noindex ?? null });
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

const noindexOf = async (url: string) => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return ((await response.json()) as { noindex: boolean }).noindex;
};

test('robots.txt keeps tool pages out and forum threads in', async () => {
  const server = await startServer();
  try {
    const response = await fetch(`${server.url}/robots.txt`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
    const body = await response.text();
    assert.match(body, /^Disallow: \/tool\/$/m);
    assert.match(body, /^Allow: \/tool\/forum$/m);
  } finally {
    await server.close();
  }
});

test('old revisions and draft proposals are marked noindex', async () => {
  const dal = await getDal();
  const prefix = `robots-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const articleSlug = `${prefix}-article`;
  const proposalSlug = `meta/proposals/${prefix}`;
  const user = await createTestUser();
  const server = await startServer();
  try {
    const first = await createWikiPage(
      dal,
      { slug: articleSlug, title: { en: 'Article' }, body: { en: 'First.' } },
      user.id
    );
    await updateWikiPage(dal, { slug: articleSlug, body: { en: 'Second.' }, revSummary: { en: 'Edit.' } }, user.id);
    assert.equal(await noindexOf(`${server.url}/${articleSlug}`), false);
    assert.equal(await noindexOf(`${server.url}/${articleSlug}?rev=${first.currentRevId}`), true);

    await createWikiPage(
      dal,
      { slug: proposalSlug, title: { en: 'Proposal' }, body: { en: 'Text.' } },
      user.id
    );
    await setProposalStatus(dal, { slug: proposalSlug, status: 'draft' }, user.id);
    assert.equal(await noindexOf(`${server.url}/${proposalSlug}`), true);
    await setProposalStatus(dal, { slug: proposalSlug, status: 'open' }, user.id);
    assert.equal(await noindexOf(`${server.url}/${proposalSlug}`), false);
  } finally {
    await server.close();
  }
});
