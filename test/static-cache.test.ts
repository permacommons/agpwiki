import assert from 'node:assert/strict';
import test from 'node:test';

import { getStaticCacheControl } from '../src/static-cache.js';

test('getStaticCacheControl gives fonts a long cache ttl', () => {
  assert.equal(getStaticCacheControl('/static/source-serif-4-400.ttf', false), 'public, max-age=2592000');
  assert.equal(getStaticCacheControl('/static/ibm-plex-sans.woff2', false), 'public, max-age=2592000');
});

test('getStaticCacheControl gives versioned assets immutable caching', () => {
  assert.equal(
    getStaticCacheControl('/static/site.css', true),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    getStaticCacheControl('/static/source-serif-4-400.ttf', true),
    'public, max-age=31536000, immutable',
  );
});

test('getStaticCacheControl gives css and js a medium cache ttl', () => {
  assert.equal(getStaticCacheControl('/static/site.css', false), 'public, max-age=3600');
  assert.equal(getStaticCacheControl('/static/search.js', false), 'public, max-age=3600');
});

test('getStaticCacheControl gives other assets a short cache ttl', () => {
  assert.equal(getStaticCacheControl('/static/logo.svg', false), 'public, max-age=300');
});
