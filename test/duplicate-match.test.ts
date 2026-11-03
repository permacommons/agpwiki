import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mainTitleWords,
  normalizeAddressForMatch,
  normalizeTitleForMatch,
  sharesMainWords,
} from '../src/lib/duplicate-match.js';
import { isArticleSlug, resolvePageAddress } from '../src/lib/page-address.js';
import { renderRevisionHistory } from '../src/routes/lib/history.js';

test('titles match ignoring capitals, accents and punctuation', () => {
  assert.equal(normalizeTitleForMatch('Gutenberg-Bibel'), normalizeTitleForMatch('gutenberg bibel'));
  assert.equal(normalizeTitleForMatch('Élysée  Palace!'), 'elysee palace');
  assert.notEqual(normalizeTitleForMatch('Gutenberg Bible'), normalizeTitleForMatch('Gutenberg Bibel'));
});

test('addresses match once hyphens and plurals are set aside', () => {
  assert.equal(normalizeAddressForMatch('world-wars'), normalizeAddressForMatch('worldwar'));
  assert.equal(normalizeAddressForMatch('gutenberg-bibles'), normalizeAddressForMatch('gutenberg-bible'));
  assert.equal(normalizeAddressForMatch('glass'), 'glass');
  assert.notEqual(normalizeAddressForMatch('foo/bar'), normalizeAddressForMatch('foobar'));
  assert.equal(normalizeAddressForMatch('foo/world-wars'), 'foo/worldwar');
  assert.notEqual(normalizeAddressForMatch('france'), normalizeAddressForMatch('frances-war'));
});

test('related titles share the main words of the new title', () => {
  const newWords = mainTitleWords('France in World War II');
  assert.deepEqual([...newWords].sort(), ['france', 'war', 'world']);
  assert.equal(sharesMainWords(newWords, mainTitleWords('France in the World Wars')), true);
  assert.equal(sharesMainWords(newWords, mainTitleWords('History of France')), false);
  assert.equal(sharesMainWords(mainTitleWords('France'), mainTitleWords('History of France')), true);
  assert.equal(sharesMainWords(mainTitleWords('Of the'), mainTitleWords('Of the')), false);
});

test('page namespaces are distinct from application routes', () => {
  assert.equal(isArticleSlug('gutenberg-bible'), true);
  assert.equal(isArticleSlug('meta/proposals/x'), false);
  assert.equal(isArticleSlug('tool/recent-changes'), false);
  assert.deepEqual(resolvePageAddress('/META/Values/'), {
    slug: 'meta/values', namespace: 'meta', localName: 'values',
  });
  assert.deepEqual(resolvePageAddress('meta/proposals/example'), {
    slug: 'meta/proposals/example', namespace: 'meta', localName: 'proposals/example',
  });
  assert.deepEqual(resolvePageAddress('foo/bar'), {
    slug: 'foo/bar', namespace: 'article', localName: 'foo/bar',
  });
  for (const prefix of ['tool', 'api', 'mcp', 'blog', 'cite', 'media']) {
    assert.equal(resolvePageAddress(`${prefix}/example`), null);
    assert.equal(resolvePageAddress(prefix), null);
  }
});

test('the version history names pages a new article was checked against', () => {
  const t = ((key: string, options?: { pages?: string }) =>
    key === 'history.notDuplicateOf' ? `Not a duplicate of ${options?.pages}` : key) as never;
  const html = renderRevisionHistory({
    action: '/x',
    viewHref: revId => `/x?rev=${revId}`,
    userMap: new Map(),
    t,
    revisions: [
      {
        revId: 'rev-1',
        dateLabel: '2026-11-01',
        title: 'X',
        summary: '',
        revUser: null,
        revTags: ['create', 'not-duplicate-of:gutenberg-bible', 'not-duplicate-of:bible'],
      },
    ],
  });
  assert.match(html, /<div class="rev-note">Not a duplicate of gutenberg-bible, bible<\/div>/);
});
