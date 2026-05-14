import assert from 'node:assert/strict';
import test from 'node:test';

import { extractMediaSlugsFromSources } from '../src/lib/media-render.js';

test('extractMediaSlugsFromSources finds basic refs', () => {
  const slugs = extractMediaSlugsFromSources([
    'See ![Grand Canyon at sunrise](/media/grand-canyon){size=500} at sunrise.',
    'And ![Audio thumb](/media/audio-foo){size=250 caption="Audio"}. Also ![Wide view](/media/grand-canyon){size=800}.',
  ]);
  assert.deepEqual([...slugs].sort(), ['audio-foo', 'grand-canyon']);
});

test('extractMediaSlugsFromSources finds multi-segment slugs', () => {
  const slugs = extractMediaSlugsFromSources([
    'See ![Erik](/media/biology/erik-portrait){size=500}.',
  ]);
  assert.deepEqual([...slugs], ['biology/erik-portrait']);
});

test('extractMediaSlugsFromSources finds refs with whitespace and titles', () => {
  const slugs = extractMediaSlugsFromSources([
    'See ![Grand Canyon](  /media/grand-canyon  "Sunrise view"  ){size=500}.',
  ]);
  assert.deepEqual([...slugs], ['grand-canyon']);
});

test('extractMediaSlugsFromSources ignores citations and external images', () => {
  const slugs = extractMediaSlugsFromSources([
    'See [@citation-key] and ![alt](https://example.com/path.png) and [link](url).',
  ]);
  assert.equal(slugs.size, 0);
});

test('extractMediaSlugsFromSources rejects uppercase and underscore slugs', () => {
  // These shouldn't match the strict slug regex even though the URL
  // form is otherwise correct.
  const slugs = extractMediaSlugsFromSources([
    '![A](/media/Grand-Canyon){size=500}',
    '![A](/media/grand_canyon){size=500}',
  ]);
  assert.equal(slugs.size, 0);
});

test('extractMediaSlugsFromSources is empty for empty sources', () => {
  assert.equal(extractMediaSlugsFromSources([]).size, 0);
  assert.equal(extractMediaSlugsFromSources(['']).size, 0);
});
