import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { initializePostgreSQL } from '../src/db.js';
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
