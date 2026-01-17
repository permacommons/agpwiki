import assert from 'node:assert/strict';
import test from 'node:test';

import { renderRevisionDiff } from '../src/routes/lib/diff.js';

test('renderRevisionDiff builds a diff details block', () => {
  const html = renderRevisionDiff({
    fromLabel: 'abc (2024-01-01)',
    toLabel: 'def (2024-01-02)',
    fromText: 'line one',
    toText: 'line two',
  });
  assert.match(html, /<details class="page-diff" open>/);
  assert.match(html, /rev:abc \(2024-01-01\)/);
  assert.match(html, /rev:def \(2024-01-02\)/);
});
