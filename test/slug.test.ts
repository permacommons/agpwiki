import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeSlugPath, isBlockedSlug, normalizeSlug } from '../src/lib/slug.js';
import { pageSignoffPath, positionReplyPath } from '../src/routes/lib/page-signoffs.js';
import { proposalLinksPath, proposalStatusPath } from '../src/routes/lib/proposal-status.js';

test('isBlockedSlug blocks empty or reserved prefixes', () => {
  assert.equal(isBlockedSlug(''), true);
  assert.equal(isBlockedSlug('health'), true);
  assert.equal(isBlockedSlug('.well-known'), true);
  assert.equal(isBlockedSlug('.well-known/oauth-authorization-server'), true);
  assert.equal(isBlockedSlug('api/status'), true);
  assert.equal(isBlockedSlug('mcp/tools'), true);
  assert.equal(isBlockedSlug('search'), true);
  assert.equal(isBlockedSlug('blog'), true);
  assert.equal(isBlockedSlug('cite'), true);
  assert.equal(isBlockedSlug('media'), true);
  assert.equal(isBlockedSlug('media/example'), true);
  assert.equal(isBlockedSlug('media-files'), true);
  assert.equal(isBlockedSlug('media-files/example/250'), true);
  assert.equal(isBlockedSlug('tool/recent-changes'), true);
  assert.equal(isBlockedSlug('tool/pages'), true);
});

test('isBlockedSlug blocks reserved suffixes', () => {
  assert.equal(isBlockedSlug('comments'), true);
  assert.equal(isBlockedSlug('meta/comments'), true);
  assert.equal(isBlockedSlug('foo/comments'), true);
  assert.equal(isBlockedSlug('checks'), true);
  assert.equal(isBlockedSlug('meta/checks'), true);
  assert.equal(isBlockedSlug('foo/checks'), true);
});

test('isBlockedSlug blocks dot segments anywhere in a slug', () => {
  for (const segment of ['.', '..']) {
    for (const slug of [segment, `${segment}/foo`, `foo/${segment}`, `foo/${segment}/bar`]) {
      assert.equal(isBlockedSlug(slug), true, slug);
    }
  }
});

test('isBlockedSlug blocks page action paths', () => {
  for (const action of [
    'operator-edit',
    'operator-edit/dismiss-banner',
    'proposal-links',
    'proposal-status',
    'position-reply',
    'sign-off',
  ]) {
    for (const slug of [action, `foo/${action}`, `foo/bar/${action}`]) {
      assert.equal(isBlockedSlug(slug), true, slug);
    }
  }
});

test('isBlockedSlug blocks check-detail paths', () => {
  assert.equal(isBlockedSlug('foo/checks/bar'), true);
  assert.equal(isBlockedSlug('foo/bar/checks/check-id'), true);
  assert.equal(isBlockedSlug('foo/checks/bar/checks/check-id'), true);
});

test('isBlockedSlug allows normal page slugs', () => {
  assert.equal(isBlockedSlug('barack-obama'), false);
  assert.equal(isBlockedSlug('meta/welcome'), false);
  assert.equal(isBlockedSlug('foo/bar'), false);
  assert.equal(isBlockedSlug('foo/bar.baz'), false);
  assert.equal(isBlockedSlug('foo/.hidden'), false);
  assert.equal(isBlockedSlug('foo/.../bar'), false);
  assert.equal(isBlockedSlug('foo/checks/bar/baz'), false);
  assert.equal(isBlockedSlug('foo/operator-edit/guide'), false);
  assert.equal(isBlockedSlug('foo/checks-and-balances'), false);
});

test('normalizeSlug trims leading and trailing slashes', () => {
  assert.equal(normalizeSlug('/foo/bar'), 'foo/bar');
  assert.equal(normalizeSlug('foo/bar/'), 'foo/bar');
  assert.equal(normalizeSlug('///foo/bar///'), 'foo/bar');
});

test('encodeSlugPath keeps slashes and encodes each segment', () => {
  assert.equal(encodeSlugPath('belt-buckle'), 'belt-buckle');
  assert.equal(encodeSlugPath('meta/proposals/profiles'), 'meta/proposals/profiles');
  assert.equal(encodeSlugPath('meta/a b/c?d#e'), 'meta/a%20b/c%3Fd%23e');
});

test('page form and redirect paths keep the slashes of nested slugs', () => {
  const slug = 'meta/proposals/profiles';
  assert.equal(positionReplyPath(slug), '/meta/proposals/profiles/position-reply');
  assert.equal(pageSignoffPath(slug), '/meta/proposals/profiles/sign-off');
  assert.equal(proposalStatusPath(slug), '/meta/proposals/profiles/proposal-status');
  assert.equal(proposalLinksPath(slug), '/meta/proposals/profiles/proposal-links');
});
