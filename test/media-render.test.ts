import assert from 'node:assert/strict';
import test from 'node:test';

import { extractMediaSlugsFromSources } from '../src/lib/media-render.js';

test('extractMediaSlugsFromSources finds basic refs', () => {
  const slugs = extractMediaSlugsFromSources([
    'See ![@grand-canyon|size=500] at sunrise.',
    'And ![@audio-foo|caption|alt=Audio|size=250]. Also ![@grand-canyon|size=800].',
  ]);
  assert.deepEqual([...slugs].sort(), ['audio-foo', 'grand-canyon']);
});

test('extractMediaSlugsFromSources finds multi-segment slugs', () => {
  const slugs = extractMediaSlugsFromSources([
    'See ![@biology/erik-portrait|size=500].',
  ]);
  assert.deepEqual([...slugs], ['biology/erik-portrait']);
});

test('extractMediaSlugsFromSources ignores citations and plain images', () => {
  const slugs = extractMediaSlugsFromSources([
    'See [@citation-key] and ![alt](/path.png) and [link](url).',
  ]);
  assert.equal(slugs.size, 0);
});

test('extractMediaSlugsFromSources rejects uppercase and underscore slugs', () => {
  // These shouldn't match the strict slug regex.
  const slugs = extractMediaSlugsFromSources([
    '![@Grand-Canyon|size=500]',
    '![@grand_canyon|size=500]',
  ]);
  assert.equal(slugs.size, 0);
});

test('extractMediaSlugsFromSources is empty for empty sources', () => {
  assert.equal(extractMediaSlugsFromSources([]).size, 0);
  assert.equal(extractMediaSlugsFromSources(['']).size, 0);
});
