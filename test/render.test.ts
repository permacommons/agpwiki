import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml, formatDateUTC, normalizeForDiff, renderUnifiedDiff } from '../src/render.js';

test('escapeHtml escapes basic characters', () => {
  const input = `<div class="x">Tom & Jerry's</div>`;
  const output = escapeHtml(input);
  assert.equal(
    output,
    '&lt;div class=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/div&gt;',
  );
});

test('formatDateUTC returns a UTC string or empty', () => {
  const value = new Date('2020-01-02T03:04:05Z');
  const formatted = formatDateUTC(value);
  assert.ok(formatted.includes('UTC'));

  const invalid = formatDateUTC('not-a-date');
  assert.equal(invalid, '');
});

test('normalizeForDiff ensures a trailing newline', () => {
  assert.equal(normalizeForDiff('line'), 'line\n');
  assert.equal(normalizeForDiff('line\n'), 'line\n');
});

test('renderUnifiedDiff highlights word-level changes and escapes HTML', () => {
  const diff = [
    '--- rev:old',
    '+++ rev:new',
    '@@ -1,2 +1,2 @@',
    '-Hello old world',
    '+Hello new world',
    ' <tag>',
  ].join('\n');

  const rendered = renderUnifiedDiff(diff);
  assert.match(rendered, /<del>old<\/del>/);
  assert.match(rendered, /<ins>new<\/ins>/);
  assert.match(rendered, /&lt;tag&gt;/);
});
