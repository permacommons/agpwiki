import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { randomBytes } from 'node:crypto';

import { initializePostgreSQL } from '../src/db.js';
import User from '../src/models/user.js';
import { setProposalStatus } from '../src/services/proposal-status-service.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';
import { registerToolRoutes } from '../src/routes/tools.js';

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | null = null;

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const makeTestServer = async () => {
  sharedDal ??= await initializePostgreSQL();
  const app = express();
  app.use((req, res, next) => {
    (req as express.Request & { t: (key: string, options?: Record<string, unknown>) => string }).t = (
      key,
      options
    ) => (options ? `${key}${JSON.stringify(options)}` : key);
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.currentUserName = null;
    res.locals.currentPath = req.originalUrl || '/';
    res.locals.accountBannerHtml = '';
    res.render = ((view: string, options?: Record<string, unknown>) => {
      res.json({ view, bodyHtml: options?.bodyHtml });
    }) as express.Response['render'];
    next();
  });
  registerToolRoutes(app);

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

const fetchPagesBody = async (baseUrl: string, query: string) => {
  const response = await fetch(`${baseUrl}/tool/pages${query}`);
  assert.equal(response.status, 200, `GET /tool/pages${query}`);
  const { bodyHtml } = (await response.json()) as { bodyHtml: string };
  return bodyHtml;
};

test('GET /tool/pages truncates fractional page and per values to integers', async () => {
  const server = await makeTestServer();
  try {
    const bodyHtml = await fetchPagesBody(server.url, '?page=2.9&per=1.5');
    assert.match(bodyHtml, /tool\.pagination\{"page":2,/);
    assert.match(bodyHtml, /href="\/tool\/pages\?page=1&per=1"/);
  } finally {
    await server.close();
  }
});

test('GET /tool/pages falls back to defaults and clamps out-of-range values', async () => {
  const server = await makeTestServer();
  try {
    const garbage = await fetchPagesBody(server.url, '?page=abc&per=xyz');
    assert.match(garbage, /tool\.pagination\{"page":1,/);
    assert.doesNotMatch(garbage, /href="\/tool\/pages\?page=0/);

    const negative = await fetchPagesBody(server.url, '?page=-4.2&per=-3.7');
    assert.match(negative, /tool\.pagination\{"page":1,/);

    const huge = await fetchPagesBody(server.url, '?page=99999999999999999999&per=500');
    assert.match(huge, /per=200"/);
  } finally {
    await server.close();
  }
});

test('GET /api/recent-changes accepts fractional and garbage limits', async () => {
  const server = await makeTestServer();
  try {
    for (const limit of ['1.5', 'abc', '-2', '1e3']) {
      const response = await fetch(`${server.url}/api/recent-changes?limit=${limit}`);
      assert.equal(response.status, 200, `limit=${limit}`);
    }
  } finally {
    await server.close();
  }
});

test('GET /tool/proposals groups proposals by status, open ones first', async () => {
  const server = await makeTestServer();
  const dal = sharedDal ?? (await initializePostgreSQL());
  const stamp = Date.now();
  const prefix = `meta/proposals/test-list-${stamp}`;
  const user = await User.create({
    username: `proposallist${stamp}`,
    displayName: 'Proposal List Test',
    email: `proposal-list-${stamp}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
  try {
    await createWikiPage(dal, { slug: `${prefix}-draftless`, title: { en: 'Without status' }, body: { en: 'Text.' } }, user.id);
    await createWikiPage(dal, { slug: `${prefix}-open`, title: { en: 'Open one' }, body: { en: 'Text.' } }, user.id);
    await setProposalStatus(dal, { slug: `${prefix}-open`, status: 'open' }, user.id);

    const response = await fetch(`${server.url}/tool/proposals`);
    assert.equal(response.status, 200);
    const { bodyHtml } = (await response.json()) as { bodyHtml: string };
    const openAt = bodyHtml.indexOf(`/${prefix}-open"`);
    const noneAt = bodyHtml.indexOf(`/${prefix}-draftless"`);
    assert.ok(openAt > -1 && noneAt > -1, 'both proposals are listed');
    assert.ok(openAt < noneAt, 'open proposals come before those without a status');
    assert.match(bodyHtml, /proposal-status--open">proposalStatus\.status\.open</);
    assert.match(bodyHtml, /proposal-status--none">proposalStatus\.noStatus</);
    assert.match(bodyHtml, /tool\.proposalsDescription\{&quot;count&quot;:\d+\}/);
  } finally {
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${prefix}%`]);
    await dal.query('DELETE FROM users WHERE id = $1', [user.id]);
    await server.close();
  }
});

test('GET /tool/issues shows one kind at a time, and the old Wikidata list redirects to it', async () => {
  const server = await makeTestServer();
  try {
    const response = await fetch(`${server.url}/tool/issues?kind=no-wikidata`);
    assert.equal(response.status, 200);
    const { bodyHtml } = (await response.json()) as { bodyHtml: string };
    assert.match(bodyHtml, /class="issue-kind issue-kind--current" href="\/tool\/issues\?kind=no-wikidata" aria-current="page">issues\.kind\.no-wikidata/);
    assert.match(bodyHtml, /href="\/tool\/issues\?kind=unchecked">issues\.kind\.unchecked/);
    assert.doesNotMatch(bodyHtml, /issue-check-filter/);

    const checks = (await (await fetch(`${server.url}/tool/issues?kind=check-issues&check=copy_edit`)).json()) as { bodyHtml: string };
    assert.match(checks.bodyHtml, /issue-check-filter/);
    assert.match(checks.bodyHtml, /check=copy_edit" aria-current="page"/);

    // Unknown kinds fall back to the first one.
    const fallback = (await (await fetch(`${server.url}/tool/issues?kind=nope`)).json()) as { bodyHtml: string };
    assert.match(fallback.bodyHtml, /kind=unchecked" aria-current="page"/);

    const redirect = await fetch(`${server.url}/tool/missing-wikidata`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/tool/issues?kind=no-wikidata');
  } finally {
    await server.close();
  }
});

test('The recent-changes pages are tabs of one Recent changes page', async () => {
  const server = await makeTestServer();
  try {
    for (const [path, key] of [
      ['/tool/recent-changes', 'recentTabs.pages'],
      ['/tool/recent-citations', 'recentTabs.citations'],
    ]) {
      const response = await fetch(`${server.url}${path}`);
      assert.equal(response.status, 200);
      const { bodyHtml } = (await response.json()) as { bodyHtml: string };
      assert.match(bodyHtml, /<nav class="tool-tabs" aria-label="recentTabs\.label">/);
      assert.ok(bodyHtml.includes(`class="tool-tab tool-tab--current" href="${path}" aria-current="page">${key}<`));
      for (const href of ['/tool/recent-changes', '/tool/recent-checks', '/tool/recent-citations', '/tool/recent-claims', '/tool/recent-media']) {
        assert.ok(bodyHtml.includes(`href="${href}"`), href);
      }
    }
  } finally {
    await server.close();
  }
});
