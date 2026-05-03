import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatMediaFigureHtml,
  formatMediaInlineHtml,
  formatMediaInvalidSizeHtml,
  formatMediaLabel,
  formatMediaMissingHtml,
  formatMediaPageTitle,
  resolveWikimediaStepForWidth,
  type MediaData,
} from '../src/lib/media.js';

const buildImageData = (): MediaData => ({
  commonsPageUrl: 'https://commons.wikimedia.org/wiki/File:Foo.jpg',
  mime: 'image/jpeg',
  width: 4096,
  height: 3072,
  thumbnailUrlTemplate: 'https://example/thumb/.../960px-Foo.jpg',
  originalUrl: 'https://example/Foo.jpg',
  license: 'CC-BY-SA-4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  author: 'Jane Doe',
  attributionHtml:
    '<a href="https://commons.wikimedia.org/wiki/User:Foo" target="_blank" rel="noreferrer noopener">Jane Doe</a>',
  fetchedAt: '2026-05-02T00:00:00Z',
});

test('formatMediaLabel uses slug + commonsTitle', () => {
  assert.equal(formatMediaLabel('foo', 'File:Bar.jpg'), 'foo - File:Bar.jpg');
  assert.equal(formatMediaLabel('foo', ''), 'foo');
});

test('formatMediaPageTitle prefers commonsTitle, falls back to slug', () => {
  assert.equal(formatMediaPageTitle('foo', 'File:Bar.jpg'), 'File:Bar.jpg');
  assert.equal(formatMediaPageTitle('foo', ''), 'foo');
});

test('resolveWikimediaStepForWidth maps to next-greater-or-equal canonical step', () => {
  assert.equal(resolveWikimediaStepForWidth(250), 250);
  assert.equal(resolveWikimediaStepForWidth(500), 500);
  // 800 falls between 500 and 960 -> rounds up to 960.
  assert.equal(resolveWikimediaStepForWidth(800), 960);
  assert.equal(resolveWikimediaStepForWidth(1280), 1280);
  assert.equal(resolveWikimediaStepForWidth(1920), 1920);
  // Anything larger than the largest step has no canonical match.
  assert.equal(resolveWikimediaStepForWidth(5000), null);
  assert.equal(resolveWikimediaStepForWidth(0), null);
});

test('formatMediaFigureHtml renders an image figure with local URL and attribution', () => {
  const html = formatMediaFigureHtml(
    { slug: 'erik-portrait', data: buildImageData() },
    {
      caption: 'A portrait',
      alt: 'Portrait alt text',
      size: 500,
      revId: 'rev-abc-123',
    }
  );
  assert.match(html, /<figure class="media media-image media-image-hero"/);
  assert.match(html, /<img src="\/media-files\/erik-portrait\/500\?v=rev-abc-123"/);
  assert.match(html, / width="500"/);
  // Aspect ratio: 4096x3072 -> 500 wide -> 375 high.
  assert.match(html, / height="375"/);
  assert.match(html, /alt="Portrait alt text"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /<figcaption><span class="media-caption-text">A portrait<\/span>/);
  assert.match(html, /CC-BY-SA-4\.0/);
  assert.match(html, /Wikimedia Commons<\/a>/);
});

test('formatMediaFigureHtml omits cache-buster when revId is missing', () => {
  const html = formatMediaFigureHtml(
    { slug: 'foo', data: buildImageData() },
    { size: 250 }
  );
  assert.match(html, /<img src="\/media-files\/foo\/250"/);
  assert.doesNotMatch(html, /\?v=/);
});

test('formatMediaFigureHtml URL-encodes multi-segment slug path safely', () => {
  const html = formatMediaFigureHtml(
    { slug: 'biology/erik-portrait', data: buildImageData() },
    { size: 500, revId: 'r1' }
  );
  // Each path segment is encoded; `/` between segments is preserved.
  assert.match(html, /\/media-files\/biology\/erik-portrait\/500\?v=r1/);
});

test('formatMediaFigureHtml escapes captions and alt text', () => {
  const html = formatMediaFigureHtml(
    { slug: 'foo', data: buildImageData() },
    { caption: '<script>x</script>', alt: '"oops"', size: 500 }
  );
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /alt="&quot;oops&quot;"/);
  assert.doesNotMatch(html, /<script>/);
});

test('formatMediaFigureHtml uses media-image-flow for sizes ≤ hero threshold', () => {
  const html = formatMediaFigureHtml(
    { slug: 'foo', data: buildImageData() },
    { size: 250 }
  );
  assert.match(html, /<figure class="media media-image media-image-flow"/);
  assert.doesNotMatch(html, /media-image-hero/);
});

test('formatMediaFigureHtml uses media-image-hero for sizes above the threshold', () => {
  const html = formatMediaFigureHtml(
    { slug: 'foo', data: buildImageData() },
    { size: 800 }
  );
  assert.match(html, /<figure class="media media-image media-image-hero"/);
  assert.doesNotMatch(html, /media-image-flow/);
});

test('formatMediaInlineHtml renders an inline image with width/height', () => {
  const html = formatMediaInlineHtml(
    { slug: 'erik-portrait', data: buildImageData() },
    { size: 250, alt: 'inline', revId: 'r' }
  );
  assert.match(html, /class="media-inline"/);
  assert.match(html, /<img class="media-inline" src="\/media-files\/erik-portrait\/250\?v=r"/);
  assert.match(html, / width="250"/);
  // 4096x3072 -> 250 wide -> 188 high.
  assert.match(html, / height="188"/);
});

test('formatMediaMissingHtml renders a placeholder with slug', () => {
  const html = formatMediaMissingHtml('missing-slug');
  assert.match(html, /class="media-missing"/);
  assert.match(html, /data-slug="missing-slug"/);
  assert.match(html, /Missing media: missing-slug/);
});

test('formatMediaMissingHtml accepts an optional reason', () => {
  const html = formatMediaMissingHtml('foo', 'bad bytes');
  assert.match(html, /Missing media: foo: bad bytes/);
});

test('formatMediaInvalidSizeHtml is operator-readable', () => {
  const html = formatMediaInvalidSizeHtml('erik-portrait', 0, [250, 800]);
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /data-slug="erik-portrait"/);
  assert.match(html, /\[invalid media size: 0 for erik-portrait\./);
  assert.match(html, /Use an integer 1.1920/);
  assert.match(html, /standard sizes: 250, 800/);
  assert.match(html, /Article column is ~768 CSS px/);
});

test('formatMediaInvalidSizeHtml escapes embedded HTML in slug or size', () => {
  const html = formatMediaInvalidSizeHtml('<x>', '<bad>', [250]);
  assert.match(html, /&lt;x&gt;/);
  assert.match(html, /&lt;bad&gt;/);
  assert.doesNotMatch(html, /<x>/);
});
