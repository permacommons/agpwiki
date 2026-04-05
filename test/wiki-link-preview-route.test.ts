import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
  WIKI_LINK_PREVIEW_ENDPOINT,
  WIKI_LINK_PREVIEW_PAGE_PATH_HEADER,
  WIKI_LINK_PREVIEW_TOKEN_HEADER,
} from '../src/lib/wiki-link-preview.js';
import { createWikiLinkPreviewToken } from '../src/lib/wiki-link-preview-token.js';
import { registerPageRoutes } from '../src/routes/pages.js';

const makeTestServer = async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    (req as express.Request & { t: (key: string, options?: Record<string, unknown>) => string }).t = (
      key,
      options
    ) => {
      if (options?.defaultValue && typeof options.defaultValue === 'string') {
        return options.defaultValue;
      }
      return key;
    };
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.currentUserName = null;
    res.locals.currentPath = req.originalUrl || '/';
    next();
  });
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

test('wiki link preview endpoint rejects missing and invalid tokens', async () => {
  const server = await makeTestServer();

  try {
    const missingTokenResponse = await fetch(`${server.url}${WIKI_LINK_PREVIEW_ENDPOINT}?slug=missing-page`);
    assert.equal(missingTokenResponse.status, 403);
    assert.deepEqual(await missingTokenResponse.json(), { error: 'invalid_token' });

    const validToken = createWikiLinkPreviewToken({
      pagePath: '/meta/welcome',
      locale: 'en',
    });
    const invalidTokenResponse = await fetch(`${server.url}${WIKI_LINK_PREVIEW_ENDPOINT}?slug=missing-page`, {
      headers: {
        [WIKI_LINK_PREVIEW_TOKEN_HEADER]: `${validToken}x`,
        [WIKI_LINK_PREVIEW_PAGE_PATH_HEADER]: '/meta/welcome',
      },
    });
    assert.equal(invalidTokenResponse.status, 403);
    assert.deepEqual(await invalidTokenResponse.json(), { error: 'invalid_token' });

    const wrongPagePathResponse = await fetch(`${server.url}${WIKI_LINK_PREVIEW_ENDPOINT}?slug=missing-page`, {
      headers: {
        [WIKI_LINK_PREVIEW_TOKEN_HEADER]: validToken,
        [WIKI_LINK_PREVIEW_PAGE_PATH_HEADER]: '/meta/other-page',
      },
    });
    assert.equal(wrongPagePathResponse.status, 403);
    assert.deepEqual(await wrongPagePathResponse.json(), { error: 'invalid_token' });
  } finally {
    await server.close();
  }
});
