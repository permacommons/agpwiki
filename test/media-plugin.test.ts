import assert from 'node:assert/strict';
import test from 'node:test';

import MarkdownIt from 'markdown-it';

import type { MediaData } from '../src/lib/media.js';
import type { MediaRegistryEntry } from '../src/lib/media-render.js';
import { mediaPlugin, parseMediaBracketContent } from '../src/markdown/media.js';

const buildEntry = (
  overrides: Partial<MediaRegistryEntry> = {}
): MediaRegistryEntry => ({
  slug: overrides.slug ?? 'grand-canyon',
  title: overrides.title ?? null,
  commonsTitle: overrides.commonsTitle ?? 'File:Grand Canyon view.jpg',
  mediaType: overrides.mediaType ?? 'image',
  data:
    overrides.data ??
    ({
      commonsPageUrl: 'https://commons.wikimedia.org/wiki/File:Grand_Canyon_view.jpg',
      mime: 'image/jpeg',
      width: 4096,
      height: 3072,
      thumbnailUrlTemplate: 'https://example/thumb/.../960px-Foo.jpg',
      originalUrl: 'https://example/full.jpg',
      license: 'CC-BY-SA-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      author: 'Jane Doe',
      attributionHtml:
        '<a href="https://commons.wikimedia.org/wiki/User:Foo" target="_blank" rel="noreferrer noopener">Jane Doe</a>',
      fetchedAt: '2026-05-02T00:00:00Z',
    } as MediaData),
  caption:
    overrides.caption ??
    ({ en: 'Default caption EN', de: 'Standardunterschrift DE' } as Record<string, string>),
  altText: overrides.altText ?? null,
  revId: overrides.revId ?? 'rev-1',
});

const renderWithRegistry = (
  source: string,
  entries: MediaRegistryEntry[],
  envOverrides: Record<string, unknown> = {}
) => {
  const md = new MarkdownIt({ html: false, linkify: true }).use(mediaPlugin());
  const registry = new Map(entries.map(e => [e.slug, e]));
  return md.render(source, { mediaRegistry: registry, ...envOverrides });
};

test('parseMediaBracketContent extracts slug only and flags missing size', () => {
  const ref = parseMediaBracketContent('@grand-canyon');
  assert.deepEqual(ref, {
    slug: 'grand-canyon',
    size: null,
    missingSize: true,
  });
});

test('parseMediaBracketContent extracts caption, alt, and size', () => {
  const ref = parseMediaBracketContent('@grand-canyon|View from south rim|alt=Canyon vista|size=800');
  assert.deepEqual(ref, {
    slug: 'grand-canyon',
    caption: 'View from south rim',
    alt: 'Canyon vista',
    size: 800,
  });
});

test('parseMediaBracketContent flags invalid size value', () => {
  const ref = parseMediaBracketContent('@grand-canyon|size=oops');
  assert.equal(ref?.size, null);
  assert.equal(ref?.invalidSize, 'oops');
});

test('parseMediaBracketContent rejects without leading @', () => {
  assert.equal(parseMediaBracketContent('grand-canyon'), null);
});

test('parseMediaBracketContent rejects empty or invalid slug', () => {
  assert.equal(parseMediaBracketContent('@'), null);
  assert.equal(parseMediaBracketContent('@|caption'), null);
  // Uppercase rejected (slug is strict lowercase).
  assert.equal(parseMediaBracketContent('@Grand-Canyon|size=500'), null);
  // Underscores rejected.
  assert.equal(parseMediaBracketContent('@grand_canyon|size=500'), null);
});

test('parseMediaBracketContent accepts multi-segment slugs', () => {
  const ref = parseMediaBracketContent('@biology/erik-portrait|size=500');
  assert.equal(ref?.slug, 'biology/erik-portrait');
  assert.equal(ref?.size, 500);
});

test('media plugin renders a figure with local URL for known slug', () => {
  const html = renderWithRegistry('![@grand-canyon|A view|size=500]\n', [buildEntry()]);
  assert.match(html, /<figure class="media media-image /);
  assert.match(html, /<img src="\/media-files\/grand-canyon\/500\?v=rev-1"/);
  assert.match(html, / width="500"/);
  assert.match(html, /<span class="media-caption-text">A view<\/span>/);
  assert.match(html, /CC-BY-SA-4\.0/);
});

test('media plugin uses entity default caption when call site omits it', () => {
  const html = renderWithRegistry('![@grand-canyon|size=500]\n', [buildEntry()]);
  assert.match(html, /Default caption EN/);
});

test('media plugin honors locale for default caption', () => {
  const html = renderWithRegistry('![@grand-canyon|size=500]\n', [buildEntry()], {
    locale: 'de',
  });
  assert.match(html, /Standardunterschrift DE/);
});

test('media plugin renders missing-media placeholder when slug not in registry', () => {
  const html = renderWithRegistry('![@unknown-slug|size=500]\n', []);
  assert.match(html, /class="media-missing"/);
  assert.match(html, /Missing media: unknown-slug/);
});

test('media plugin renders invalid-size placeholder when size= is missing', () => {
  const html = renderWithRegistry('![@grand-canyon]\n', [buildEntry()]);
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /\(missing\)/);
  assert.match(html, /standard sizes: 250, 800/);
  assert.match(html, /Use an integer 1.1920/);
});

test('media plugin renders invalid-size placeholder when size is out of range', () => {
  const html = renderWithRegistry('![@grand-canyon|size=2000]\n', [buildEntry()]);
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /invalid media size: 2000 for grand-canyon/);
  assert.match(html, /Use an integer 1.1920/);
});

test('media plugin accepts non-standard sizes inside the valid range', () => {
  // 600 isn't in the standard set but it's a valid integer in [1, 1920].
  // The renderer should produce a normal figure, not an invalid-size error.
  const html = renderWithRegistry('![@grand-canyon|size=600]\n', [buildEntry()]);
  assert.doesNotMatch(html, /class="media-invalid-size"/);
  assert.match(html, /<img src="\/media-files\/grand-canyon\/600\?v=rev-1"/);
  assert.match(html, / width="600"/);
});

test('media plugin renders invalid-size placeholder when size= value is unparseable', () => {
  const html = renderWithRegistry('![@grand-canyon|size=oops]\n', [buildEntry()]);
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /oops/);
});

test('media plugin does not match standard image syntax', () => {
  const html = renderWithRegistry('![alt text](https://example/img.jpg)\n', []);
  assert.match(html, /<img src="https:\/\/example\/img\.jpg" alt="alt text"/);
  assert.doesNotMatch(html, /class="media-/);
});

test('media plugin lifts a solo media paragraph out of <p>', () => {
  const html = renderWithRegistry('![@grand-canyon|Caption|size=500]\n', [buildEntry()]);
  // Figure must not be wrapped in a paragraph.
  assert.doesNotMatch(html, /<p>[\s\S]*<figure/);
  assert.match(html, /^\s*<figure class="media media-image /);
});

test('media plugin renders inline media as a bare element (no figure)', () => {
  const html = renderWithRegistry('See ![@grand-canyon|size=250] here.\n', [buildEntry()]);
  assert.match(html, /<p>See <img class="media-inline"[^>]+> here\.<\/p>/);
  assert.doesNotMatch(html, /<p>[\s\S]*<figure/);
});

test('media plugin honors env-provided recommendedDisplayWidths in invalid-size hints', () => {
  // The env override no longer gates validity (any integer 1–1920 is
  // valid); it shapes the operator-readable hint shown when validation
  // fails. Confirm the hint reflects the override.
  const html = renderWithRegistry(
    '![@grand-canyon|size=0]\n',
    [buildEntry()],
    { recommendedDisplayWidths: [100, 200, 300] }
  );
  assert.match(html, /standard sizes: 100, 200, 300/);
});
