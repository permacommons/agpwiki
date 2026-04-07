import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAccountRequestProfileField } from '../src/routes/lib/account-request-form.js';

const t = (key: string) =>
  ({
    'accountRequest.form.profileUrl': 'Online profile link (optional)',
    'accountRequest.form.profileUrlHint':
      'Share a link to a social profile, personal homepage, or other online presence if you have one.',
  })[key] ?? key;

test('renderAccountRequestProfileField renders an optional URL field', () => {
  const html = renderAccountRequestProfileField(t as never);

  assert.match(html, /Online profile link \(optional\)/);
  assert.match(html, /type="url"/);
  assert.match(html, /name="profileUrl"/);
  assert.match(html, /autocomplete="url"/);
  assert.doesNotMatch(html, /required/);
});

test('renderAccountRequestProfileField escapes preserved values', () => {
  const html = renderAccountRequestProfileField(t as never, 'https://example.com/?q=<test>');

  assert.match(html, /value="https:\/\/example\.com\/\?q=&lt;test&gt;"/);
});
