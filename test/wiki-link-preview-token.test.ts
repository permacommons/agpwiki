import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWikiLinkPreviewToken,
  verifyWikiLinkPreviewToken,
} from '../src/lib/wiki-link-preview-token.js';

test('wiki link preview tokens round-trip and carry page context', () => {
  const now = Date.UTC(2026, 3, 5, 12, 0, 0);
  const token = createWikiLinkPreviewToken({
    pagePath: '/foo/bar',
    locale: 'en',
    now,
  });

  assert.deepEqual(verifyWikiLinkPreviewToken(token, now), {
    pagePath: '/foo/bar',
    locale: 'en',
    exp: Math.floor(now / 1000) + 86400,
  });
});

test('wiki link preview tokens reject tampering and expiry', () => {
  const now = Date.UTC(2026, 3, 5, 12, 0, 0);
  const token = createWikiLinkPreviewToken({
    pagePath: '/foo/bar',
    locale: 'en',
    now,
  });

  assert.equal(verifyWikiLinkPreviewToken(`${token}x`, now), null);
  assert.equal(verifyWikiLinkPreviewToken(token, now + 86401 * 1000), null);
});
