import assert from 'node:assert/strict';
import test from 'node:test';

import { renderRevisionHistory } from '../src/routes/lib/history.js';

test('renderRevisionHistory marks default diff selections', () => {
  const html = renderRevisionHistory({
    action: '/tool/test',
    viewHref: revId => `/tool/test?rev=${revId}`,
    userMap: new Map(),
    revisions: [
      {
        revId: 'rev-2',
        dateLabel: '2024-01-02',
        title: 'Second',
        summary: '',
        revUser: null,
        revTags: null,
      },
      {
        revId: 'rev-1',
        dateLabel: '2024-01-01',
        title: 'First',
        summary: '',
        revUser: null,
        revTags: null,
      },
    ],
  });

  assert.match(html, /name="diffTo" value="rev-2" checked/);
  assert.match(html, /name="diffFrom" value="rev-1" checked/);
  assert.match(html, /<a href="\/tool\/test\?rev=rev-2">View<\/a>/);
});
