import assert from 'node:assert/strict';
import test from 'node:test';

import { getDiffLabels, renderEntityDiff } from '../src/routes/lib/diff.js';

test('renderEntityDiff builds a diff block', () => {
  const html = renderEntityDiff({
    fromLabel: 'abc (2024-01-01)',
    toLabel: 'def (2024-01-02)',
    fromHref: '/revs/abc',
    toHref: '/revs/def',
    labels: getDiffLabels(key => key),
    fields: [
      {
        key: 'title',
        diff: { kind: 'scalar', from: 'old', to: 'new' },
      },
    ],
  });
  assert.match(html, /<section class="page-diff">/);
  assert.match(
    html,
    /<strong>diff\.revision:<\/strong> <a href="\/revs\/abc">abc<\/a> \(2024-01-01\) → <a href="\/revs\/def">def<\/a> \(2024-01-02\)/
  );
  assert.match(html, /href="\/revs\/abc"/);
  assert.match(html, /href="\/revs\/def"/);
  assert.match(html, /<details class="diff-field" open>/);
});
