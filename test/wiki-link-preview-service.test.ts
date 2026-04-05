import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractLeadMarkdownSource,
  extractLocalPreviewHtml,
  extractWikipediaPreviewHtml,
  sanitizeWikipediaParagraphHtml,
} from '../src/services/wiki-link-preview-service.js';

test('sanitizeWikipediaParagraphHtml keeps only safe inline tags and wikipedia links', () => {
  const html =
    'Text <b>bold</b> <span class="x">wrapped</span> <a href="/wiki/Barack_Obama" class="mw">link</a> <a href="javascript:alert(1)">bad</a><sup class="reference">[1]</sup>';

  assert.equal(
    sanitizeWikipediaParagraphHtml(html),
    'Text <b>bold</b> wrapped <a href="https://en.wikipedia.org/wiki/Barack_Obama" target="_blank" rel="noreferrer noopener">link</a> bad'
  );
});

test('sanitizeWikipediaParagraphHtml removes embedded style blocks entirely', () => {
  const html =
    'Height was measured as <style>.mw-parser-output .frac{white-space:nowrap}</style><span class="nowrap">8,848.86 m</span>.';

  assert.equal(
    sanitizeWikipediaParagraphHtml(html),
    'Height was measured as 8,848.86 m.'
  );
});

test('extractWikipediaPreviewHtml keeps the first non-empty sanitized paragraph', () => {
  const html = `
<div class="mw-parser-output">
  <table><tr><td>Ignore infobox</td></tr></table>
  <p><span class="geo">Example</span> is a <a href="/wiki/Test">topic</a>.<sup>[1]</sup></p>
  <p></p>
  <p>Second <i>paragraph</i> with <a href="https://en.wikipedia.org/wiki/Second">another link</a>.</p>
  <p>Third paragraph should be dropped.</p>
</div>`;

  assert.equal(
    extractWikipediaPreviewHtml(html),
    '<p>Example is a <a href="https://en.wikipedia.org/wiki/Test" target="_blank" rel="noreferrer noopener">topic</a>.</p>'
  );
});

test('extractLeadMarkdownSource prefers markdown before the first heading', () => {
  const source = `Lead paragraph.

Second lead paragraph.

## History

Later section.`;

  assert.equal(
    extractLeadMarkdownSource(source),
    'Lead paragraph.\n\nSecond lead paragraph.'
  );
});

test('extractLocalPreviewHtml keeps the first paragraph and removes citation groups', () => {
  const html =
    '<p>Lead <span class="citation-group"><sup class="citation-ref">[<a href="#ref-1">1</a>]</sup></span> text.</p><p>Second paragraph.</p>';

  assert.equal(extractLocalPreviewHtml(html), '<p>Lead text.</p>');
});
