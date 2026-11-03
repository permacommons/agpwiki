import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mainTitleWords,
  matchPossibleDuplicates,
  normalizeAddressForMatch,
  normalizeTitleForMatch,
  sharesMainWords,
} from '../src/lib/duplicate-match.js';
import { articleSlugExclusions, isArticleSlug, PAGE_NAMESPACES, resolvePageAddress } from '../src/lib/page-address.js';
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


test('registered namespaces drive classification and article exclusions', () => {
  for (const definition of PAGE_NAMESPACES) {
    const slug = `${definition.prefix}example`;
    assert.deepEqual(resolvePageAddress(slug), {
      slug, namespace: definition.name, localName: 'example',
    });
    if (definition.prefix) {
      assert.ok(articleSlugExclusions.includes(`${definition.prefix}%`));
    }
  }
});

test('candidate matching preserves multilingual suggestions without combining translations', () => {
  const pages = [
    { slug: 'meta/english', title: { en: 'History of France' }, wikidata: null },
    { slug: 'meta/german', title: { de: 'Geschichte von Frankreich' }, wikidata: null },
    { slug: 'meta/mixed', title: { en: 'France Frankreich archive' }, wikidata: null },
    { slug: 'article', title: { en: 'France' }, wikidata: null },
  ];
  const address = resolvePageAddress('meta/probe');
  const match = (titles: string[]) => matchPossibleDuplicates({ titles, address }, pages, []);
  assert.deepEqual(match(['France']).related.map(page => page.slug), ['meta/english', 'meta/mixed']);
  assert.deepEqual(match(['France', 'Frankreich']).related.map(page => page.slug),
    ['meta/english', 'meta/german', 'meta/mixed']);
  assert.deepEqual(match(['France astronomy', 'Frankreich botany']).related, []);
  assert.deepEqual(match(['of the']).related, []);
});

test('candidate matching scopes pages and aliases independently and reports every match reason', () => {
  const pages = [
    { slug: 'meta/france', title: { en: 'Fránce' }, wikidata: 'Q142' },
    { slug: 'france', title: { en: 'France' }, wikidata: 'Q142' },
    { slug: 'foreign-target', title: null, wikidata: null },
    { slug: 'tool/invalid', title: { en: 'France' }, wikidata: 'Q142' },
  ];
  const aliases = [
    { slug: 'meta/frances', pageSlug: 'meta/france' },
    { slug: 'meta/france', pageSlug: 'foreign-target' },
    { slug: 'france', pageSlug: 'foreign-target' },
  ];
  const result = matchPossibleDuplicates({
    titles: ['FRANCE'], address: resolvePageAddress('meta/france'), wikidata: 'Q142',
  }, pages, aliases);
  assert.deepEqual(result.duplicates.map(page => [page.slug, page.matchedBy]), [
    ['foreign-target', ['alias', 'address']],
    ['meta/france', ['wikidata', 'title', 'address']],
  ]);
  assert.deepEqual(result.related, []);
  const withoutScopedAlias = matchPossibleDuplicates({
    titles: ['France'], address: resolvePageAddress('meta/probe'),
  }, pages, [{ slug: 'france', pageSlug: 'foreign-target' }]);
  assert.deepEqual(withoutScopedAlias.duplicates.map(page => page.slug), ['meta/france']);
});


test('related candidates rank by their best title match with stable ties and a result limit', () => {
  const pages = Array.from({ length: 12 }, (_, index) => ({
    slug: `related-${String(index).padStart(2, '0')}`,
    title: { en: `France region ${index}` },
    wikidata: null,
  }));
  pages.push({ slug: 'strongest', title: { en: 'France World War history' }, wikidata: null });
  const result = matchPossibleDuplicates({
    titles: ['France', 'France World War'], address: resolvePageAddress('proposed'),
  }, pages.reverse(), []);
  assert.deepEqual(result.related.map(page => page.slug), [
    'strongest', ...Array.from({ length: 9 }, (_, index) => `related-${String(index).padStart(2, '0')}`),
  ]);
});
