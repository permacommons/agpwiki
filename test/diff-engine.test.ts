import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffLocalizedField,
  diffScalarField,
  diffStructuredField,
  diffTextField,
} from '../src/lib/diff-engine.js';

test('diffLocalizedField reports added, removed, and modified languages', () => {
  const diff = diffLocalizedField(
    'title',
    { en: 'Old', de: 'Alt' },
    { en: 'New', fr: 'Nouveau' }
  );

  assert.ok(diff);
  assert.equal(diff.kind, 'localized');
  assert.deepEqual(diff.added, [{ lang: 'fr', value: 'Nouveau' }]);
  assert.deepEqual(diff.removed, [{ lang: 'de', value: 'Alt' }]);
  assert.ok(diff.modified.en);
  assert.equal(diff.modified.en.from, 'Old');
  assert.equal(diff.modified.en.to, 'New');
});

test('diffLocalizedField returns null for identical maps', () => {
  const diff = diffLocalizedField('body', { en: 'Same' }, { en: 'Same' });
  assert.equal(diff, null);
});

test('diffStructuredField reports nested changes with paths', () => {
  const diff = diffStructuredField(
    'data',
    { a: 1, b: { c: 2 }, d: [1, 2] },
    { a: 1, b: { c: 3 }, d: [1], e: true }
  );

  assert.ok(diff);
  assert.equal(diff.kind, 'structured');
  const paths = diff.changes.map(change => `${change.type}:${change.path}`);
  assert.ok(paths.includes('modified:/b/c'));
  assert.ok(paths.includes('removed:/d/1'));
  assert.ok(paths.includes('added:/e'));
});

test('diffScalarField normalizes dates and detects changes', () => {
  const diff = diffScalarField(
    'completedAt',
    new Date('2020-01-02T03:04:05Z'),
    new Date('2020-01-03T00:00:00Z')
  );
  assert.ok(diff);
  assert.equal(diff.kind, 'scalar');
  assert.equal(diff.from, '2020-01-02T03:04:05.000Z');
  assert.equal(diff.to, '2020-01-03T00:00:00.000Z');
});

test('diffTextField returns a text diff when content changes', () => {
  const diff = diffTextField('notes', 'Line one', 'Line two');
  assert.ok(diff);
  assert.equal(diff.kind, 'text');
  assert.match(diff.diff.unifiedDiff, /Line one/);
  assert.match(diff.diff.unifiedDiff, /Line two/);
});
