import assert from 'node:assert/strict';
import test from 'node:test';

import MarkdownIt from 'markdown-it';

import type { MediaData } from '../src/lib/media.js';
import type { MediaRegistryEntry } from '../src/lib/media-render.js';
import { mediaPlugin } from '../src/markdown/media.js';

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

test('media plugin renders a figure with local URL for known slug', () => {
  const html = renderWithRegistry(
    '![A view](/media/grand-canyon){size=500}\n',
    [buildEntry()]
  );
  assert.match(html, /<figure class="media media-image /);
  assert.match(html, /<img src="\/media-files\/grand-canyon\/500\?v=rev-1"/);
  assert.match(html, / width="500"/);
  // Alt text comes from the standard image alt position.
  assert.match(html, /alt="A view"/);
  assert.match(html, /CC-BY-SA-4\.0/);
});

test('media plugin uses caption from {caption="..."} attribute', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=500 caption="A view from the south rim"}\n',
    [buildEntry()]
  );
  assert.match(html, /<span class="media-caption-text">A view from the south rim<\/span>/);
});

test('media plugin uses entity default caption when call site omits it', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=500}\n',
    [buildEntry()]
  );
  assert.match(html, /Default caption EN/);
});

test('media plugin honors locale for default caption', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=500}\n',
    [buildEntry()],
    { locale: 'de' }
  );
  assert.match(html, /Standardunterschrift DE/);
});

test('media plugin renders missing-media placeholder when slug not in registry', () => {
  const html = renderWithRegistry(
    '![Alt](/media/unknown-slug){size=500}\n',
    []
  );
  assert.match(html, /class="media-missing"/);
  assert.match(html, /Missing media: unknown-slug/);
});

test('media plugin renders invalid-size placeholder when {size=} is missing', () => {
  // Image with no attribute block at all.
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon)\n',
    [buildEntry()]
  );
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /\(missing\)/);
  assert.match(html, /standard sizes: 250, 800/);
  assert.match(html, /Use an integer 1.1920/);
});

test('media plugin renders invalid-size placeholder when block omits size', () => {
  // Attribute block present but without size=.
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){caption="Just a caption"}\n',
    [buildEntry()]
  );
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /\(missing\)/);
});

test('media plugin renders invalid-size placeholder when size is out of range', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=2000}\n',
    [buildEntry()]
  );
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /invalid media size: 2000 for grand-canyon/);
  assert.match(html, /Use an integer 1.1920/);
});

test('media plugin accepts non-standard sizes inside the valid range', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=600}\n',
    [buildEntry()]
  );
  assert.doesNotMatch(html, /class="media-invalid-size"/);
  assert.match(html, /<img src="\/media-files\/grand-canyon\/600\?v=rev-1"/);
  assert.match(html, / width="600"/);
});

test('media plugin renders invalid-size placeholder when size= value is unparseable', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=oops}\n',
    [buildEntry()]
  );
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /oops/);
});

test('media plugin renders invalid-slug placeholder for malformed slug', () => {
  const html = renderWithRegistry(
    '![Alt](/media/Grand-Canyon){size=500}\n',
    []
  );
  assert.match(html, /class="media-invalid-slug"/);
  assert.match(html, /invalid media slug: Grand-Canyon/);
});

test('media plugin renders invalid-attrs placeholder for unknown attribute keys', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=500 alt="bogus" .myclass}\n',
    [buildEntry()]
  );
  assert.match(html, /class="media-invalid-attrs"/);
  // Both unknown tokens reported.
  assert.match(html, /alt=&quot;bogus&quot;/);
  assert.match(html, /\.myclass/);
});

test('media plugin leaves external images alone (validator rejects them)', () => {
  // External URLs stay as standard <img> tokens; the standard-image
  // validator handles rejection at write time. Plugin doesn't claim them.
  const html = renderWithRegistry(
    '![alt text](https://example/img.jpg)\n',
    []
  );
  assert.match(html, /<img src="https:\/\/example\/img\.jpg" alt="alt text"/);
  assert.doesNotMatch(html, /class="media-/);
});

test('media plugin lifts a solo media paragraph out of <p>', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=500 caption="Caption"}\n',
    [buildEntry()]
  );
  assert.doesNotMatch(html, /<p>[\s\S]*<figure/);
  assert.match(html, /^\s*<figure class="media media-image /);
});

test('media plugin renders inline media as a bare element (no figure)', () => {
  const html = renderWithRegistry(
    'See ![Alt](/media/grand-canyon){size=250} here.\n',
    [buildEntry()]
  );
  assert.match(html, /<p>See <img class="media-inline"[^>]+> here\.<\/p>/);
  assert.doesNotMatch(html, /<p>[\s\S]*<figure/);
});

test('media plugin honors env-provided recommendedDisplayWidths in invalid-size hints', () => {
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=0}\n',
    [buildEntry()],
    { recommendedDisplayWidths: [100, 200, 300] }
  );
  assert.match(html, /standard sizes: 100, 200, 300/);
});

test('media plugin accepts single-quoted captions containing double quotes', () => {
  // Pandoc convention allows either quote style.
  const html = renderWithRegistry(
    `![Alt](/media/grand-canyon){size=500 caption='She said "hi"'}\n`,
    [buildEntry()]
  );
  assert.match(html, /<span class="media-caption-text">She said &quot;hi&quot;<\/span>/);
});

test('media plugin accepts double-quoted captions with escaped quotes', () => {
  // Inline ruler reads from raw state.src so markdown-it's `\"`
  // escape rule never strips the backslash before our parser sees it.
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=500 caption="She said \\"hi\\""}\n',
    [buildEntry()]
  );
  assert.match(html, /<span class="media-caption-text">She said &quot;hi&quot;<\/span>/);
});

test('media plugin parses (and renders) markdown inside caption', () => {
  // Regression test for an agentic-test finding: caption containing
  // `*italic*` previously got chopped because markdown-it tokenized
  // the asterisks as emphasis BEFORE our parser ran, splitting the
  // `{...}` block across multiple text tokens. The inline ruler
  // reads from state.src directly so the asterisks survive parsing,
  // and the renderer then sends the caption through a dedicated
  // markdown-it inline pass so binomial names render with `<em>`.
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=500 caption="Inflorescence of *C. thomsoniae*, showing the calyx."}\n',
    [buildEntry()]
  );
  assert.doesNotMatch(html, /class="media-invalid-size"/);
  assert.match(
    html,
    /<span class="media-caption-text">Inflorescence of <em>C\. thomsoniae<\/em>, showing the calyx\.<\/span>/
  );
});

test('media plugin escapes html-unsafe chars inside caption', () => {
  // `html: false` on the caption renderer means raw HTML stays
  // escaped — only proper inline markdown produces tags.
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon){size=500 caption="<script>alert(1)</script>"}\n',
    [buildEntry()]
  );
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('media plugin does not consume {...} on a separate line', () => {
  // The attribute block must be immediately adjacent to the closing
  // `)`. A brace on the next line is regular text, not an attribute
  // block — and the size remains missing so we render a missing-size
  // placeholder.
  const html = renderWithRegistry(
    '![Alt](/media/grand-canyon)\n{size=500}\n',
    [buildEntry()]
  );
  assert.match(html, /class="media-invalid-size"/);
  assert.match(html, /\{size=500\}/);
});
