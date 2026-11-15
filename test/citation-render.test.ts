import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCitationKeysFromSources } from '../src/lib/citation-render.js';
import { renderMarkdown } from '../src/render.js';

const webpage = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  type: 'webpage',
  title: `Title of ${id}`,
  URL: `https://example.com/${id}`,
  ...fields,
});

test('extractCitationKeysFromSources parses citation and claim refs', () => {
  const keys = extractCitationKeysFromSources([
    'Text with [@alpha].',
    'Another [@beta:claim-id; @gamma].',
    'Bare token @ignored is still extracted for parity with route parsing.',
  ]);

  assert.deepEqual([...keys].sort(), ['alpha', 'beta', 'gamma', 'ignored']);
});

test('renderMarkdown includes bibliography entries for citations', async () => {
  const { html } = await renderMarkdown('Testing [@alpha].', [
    webpage('alpha', { title: 'Agpedia Test Citation', accessed: { 'date-parts': [[2024, 1, 1]] } }),
  ]);
  assert.match(html, /Agpedia Test Citation/);
});

test('renderMarkdown supports adjacent bracket citations', async () => {
  const { html } = await renderMarkdown('Testing [@alpha][@beta].', [webpage('alpha'), webpage('beta')]);
  assert.equal((html.match(/citation-group/g) ?? []).length, 2);
  assert.doesNotMatch(html, /\[\s*<span class="citation-group">/);
});

test('renderMarkdown links citation claims in bibliography', async () => {
  const { html } = await renderMarkdown('Testing [@alpha:birthdate].', [webpage('alpha')]);
  assert.match(html, /\/cite\/alpha#claim-birthdate/);
});

test('renderMarkdown disambiguates multiple claim refs with numeric slots', async () => {
  const { html } = await renderMarkdown('Testing [@alpha:first][@alpha:second].', [webpage('alpha')]);
  assert.match(html, /href="#ref-1-1">1:1<\/a>/);
  assert.match(html, /href="#ref-1-2">1:2<\/a>/);
  assert.match(html, /id="ref-1-1" class="ref-claim-pair"/);
  assert.match(html, /id="ref-1-2" class="ref-claim-pair"/);
  assert.match(html, /\/cite\/alpha#claim-first/);
  assert.match(html, /\/cite\/alpha#claim-second/);
});

test('renderMarkdown keeps non-claim duplicate refs unsuffixed', async () => {
  const { html } = await renderMarkdown('Testing [@alpha][@alpha].', [webpage('alpha')]);
  assert.equal((html.match(/href="#ref-1">1<\/a>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /href="#ref-1a">1a<\/a>/);
});

test('renderMarkdown groups repeated same-claim refs under one claim slot', async () => {
  const { html } = await renderMarkdown('Testing [@alpha:first] and later [@alpha:first].', [
    webpage('alpha'),
  ]);
  assert.equal((html.match(/href="#ref-1-1">1:1<\/a>/g) ?? []).length, 2);
  assert.equal((html.match(/id="ref-1-1" class="ref-claim-pair"/g) ?? []).length, 1);
  assert.match(html, /id="ref-1-1" class="ref-claim-pair">[\s\S]*\^a[\s\S]*\^b/);
});

test('renderMarkdown ignores bare @key tokens', async () => {
  const { html } = await renderMarkdown('Contact @no-such-citation:bad-claim.', []);
  assert.doesNotMatch(html, /citation-group/);
  assert.doesNotMatch(html, /citation-ref/);
});

test('renderMarkdown punctuation handles author-only citations without year', async () => {
  const { html } = await renderMarkdown('Testing [@alpha].', [
    webpage('alpha', {
      title: 'Sandbox citation with no year',
      author: [{ family: 'Tester', given: 'Alex' }],
    }),
  ]);
  assert.match(html, /Tester, Alex\. Sandbox citation with no year\./);
  assert.doesNotMatch(html, /AlexSandbox/);
});
