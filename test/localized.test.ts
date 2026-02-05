import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeLocalizedMap, sanitizeLocalizedMapInput } from '../src/mcp/localized.js';

test('sanitizeLocalizedMapInput strips nulls and empties', () => {
  assert.equal(sanitizeLocalizedMapInput(undefined), undefined);
  assert.equal(sanitizeLocalizedMapInput(null), null);
  assert.deepEqual(sanitizeLocalizedMapInput({ en: 'Hello', de: null }), { en: 'Hello' });
  assert.equal(sanitizeLocalizedMapInput({ en: null }), null);
});

test('mergeLocalizedMap merges and deletes language keys', () => {
  const merged = mergeLocalizedMap(
    { en: 'Hello', de: 'Hallo' },
    { de: null, fr: 'Salut' }
  );

  assert.deepEqual(merged, { en: 'Hello', fr: 'Salut' });
});
