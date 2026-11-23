import assert from 'node:assert/strict';
import test from 'node:test';

import { navSectionFor } from '../src/lib/nav-section.js';

test('navSectionFor marks the header section a page belongs to', () => {
  assert.equal(navSectionFor('/blog'), 'blog');
  assert.equal(navSectionFor('/blog/drafts'), 'blog');
  assert.equal(navSectionFor('/blog/drafts/discussion'), 'blog');
  assert.equal(navSectionFor('/tool/forum'), 'forum');
  assert.equal(navSectionFor('/tool/forum/general?page=2'), 'forum');
  assert.equal(navSectionFor('/fiddle-improvisation/discussion'), 'forum');
  assert.equal(navSectionFor('/tool/recent-changes'), 'tools');
  assert.equal(navSectionFor('/tool/proposals'), 'tools');
  assert.equal(navSectionFor('/meta/proposals/page-views'), 'tools');
  assert.equal(navSectionFor('/meta/help'), 'contribute');
  assert.equal(navSectionFor('/meta/help/'), 'contribute');
  assert.equal(navSectionFor('/meta/setup'), 'contribute');
  assert.equal(navSectionFor('/meta/developers'), 'developers');
  assert.equal(navSectionFor('/meta/mcp-reference'), 'developers');
});

test('Articles, the home page and other pages belong to no section', () => {
  for (const path of ['/', '/meta/welcome', '/fiddle-improvisation', '/meta/values', '/tool/login', '/blogger', '/meta/helpful']) {
    assert.equal(navSectionFor(path), null, path);
  }
});
