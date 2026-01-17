import assert from 'node:assert/strict';
import test from 'node:test';

import { isBlockedSlug } from '../src/lib/slug.js';

test('isBlockedSlug blocks empty or reserved prefixes', () => {
  assert.equal(isBlockedSlug(''), true);
  assert.equal(isBlockedSlug('health'), true);
  assert.equal(isBlockedSlug('api/status'), true);
  assert.equal(isBlockedSlug('mcp/tools'), true);
  assert.equal(isBlockedSlug('search'), true);
  assert.equal(isBlockedSlug('blog'), true);
  assert.equal(isBlockedSlug('cite'), true);
  assert.equal(isBlockedSlug('tool/recent-changes'), true);
  assert.equal(isBlockedSlug('tool/pages'), true);
});

test('isBlockedSlug blocks reserved suffixes', () => {
  assert.equal(isBlockedSlug('comments'), true);
  assert.equal(isBlockedSlug('meta/comments'), true);
  assert.equal(isBlockedSlug('foo/comments'), true);
});

test('isBlockedSlug allows normal page slugs', () => {
  assert.equal(isBlockedSlug('barack-obama'), false);
  assert.equal(isBlockedSlug('meta/welcome'), false);
  assert.equal(isBlockedSlug('foo/bar'), false);
});
