import assert from 'node:assert/strict';
import test from 'node:test';

import {
  escapeHtml,
  formatDateUTC,
  normalizeForDiff,
  renderMarkdown,
  renderToc,
  renderUnifiedDiff,
} from '../src/render.js';

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

test('renderMarkdown extracts TOC with human-readable slugs', async () => {
  const markdown = `# Introduction
Some text here.

## Getting Started
More content.

## Getting Started
Duplicate heading.

### Sub-Section
Nested content.`;

  const { html, toc } = await renderMarkdown(markdown, []);

  assert.equal(toc.length, 4);
  assert.deepEqual(toc[0], { level: 1, text: 'Introduction', slug: 'introduction' });
  assert.deepEqual(toc[1], { level: 2, text: 'Getting Started', slug: 'getting-started' });
  assert.deepEqual(toc[2], { level: 2, text: 'Getting Started', slug: 'getting-started-2' });
  assert.deepEqual(toc[3], { level: 3, text: 'Sub-Section', slug: 'sub-section' });

  assert.match(html, /id="introduction"/);
  assert.match(html, /id="getting-started"/);
  assert.match(html, /id="getting-started-2"/);
  assert.match(html, /id="sub-section"/);
});

test('renderMarkdown handles Unicode in heading slugs', async () => {
  const markdown = `## Über Uns
## 日本語タイトル
## Título en Español`;

  const { toc } = await renderMarkdown(markdown, []);

  assert.equal(toc.length, 3);
  assert.equal(toc[0].slug, 'über-uns');
  assert.equal(toc[1].slug, '日本語タイトル');
  assert.equal(toc[2].slug, 'título-en-español');
});

test('renderToc generates collapsible HTML', () => {
  const items = [
    { level: 1, text: 'Introduction', slug: 'introduction' },
    { level: 2, text: 'Background', slug: 'background' },
  ];

  const expanded = renderToc(items, { expanded: true, label: 'Contents' });
  assert.match(expanded, /<details class="page-toc" open>/);
  assert.match(expanded, /<summary>Contents<\/summary>/);
  assert.match(expanded, /<a href="#introduction">Introduction<\/a>/);
  assert.match(expanded, /<a href="#background">Background<\/a>/);

  const collapsed = renderToc(items, { expanded: false, label: 'Contents' });
  assert.match(collapsed, /<details class="page-toc">/);
  assert.doesNotMatch(collapsed, / open>/);
});

test('renderToc returns empty string for no items', () => {
  const result = renderToc([], { expanded: true, label: 'Contents' });
  assert.equal(result, '');
});
