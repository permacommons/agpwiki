import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildThumbnailUrlForWidth,
  fetchCommonsMetadata,
  normalizeCommonsTitle,
  sanitizeCommonsHtml,
  synthesizeWikimediaThumbnailTemplate,
} from '../src/lib/commons.js';
import { McpToolError, NotFoundError } from '../src/lib/errors.js';

const buildImageResponse = () => ({
  query: {
    pages: [
      {
        pageid: 12345,
        ns: 6,
        title: 'File:Erik Moeller, cross processed portrait.JPG',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/d/d2/Erik_Moeller%2C_cross_processed_portrait.JPG',
            thumburl:
              'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Erik_Moeller%2C_cross_processed_portrait.JPG/960px-Erik_Moeller%2C_cross_processed_portrait.JPG',
            thumbwidth: 960,
            thumbheight: 1280,
            width: 2400,
            height: 3200,
            mime: 'image/jpeg',
            mediatype: 'BITMAP',
            extmetadata: {
              LicenseShortName: { value: 'CC-BY-SA-3.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/3.0/' },
              Artist: { value: '<a href="https://commons.wikimedia.org/wiki/User:Eloquence">Erik Möller</a>' },
              Credit: { value: 'Own work' },
              Attribution: {
                value: '<a href="https://commons.wikimedia.org/wiki/User:Eloquence">Erik Möller</a>, CC BY-SA 3.0',
              },
              ImageDescription: {
                value:
                  '<div class="description en">Cross-processed portrait of Erik Möller.</div>',
              },
            },
          },
        ],
      },
    ],
  },
});

const stubFetch = (responseBody: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

test('normalizeCommonsTitle adds File: prefix and converts underscores', () => {
  assert.equal(normalizeCommonsTitle('Cat.jpg'), 'File:Cat.jpg');
  assert.equal(normalizeCommonsTitle('File:Cat.jpg'), 'File:Cat.jpg');
  assert.equal(normalizeCommonsTitle('file:Foo_Bar.png'), 'file:Foo Bar.png');
});

test('normalizeCommonsTitle returns empty for empty input', () => {
  assert.equal(normalizeCommonsTitle(''), '');
  assert.equal(normalizeCommonsTitle('   '), '');
});

test('sanitizeCommonsHtml allows safe tags and re-escapes hrefs', () => {
  const out = sanitizeCommonsHtml('<a href="https://example.org">Foo</a><script>x</script><b>bold</b>');
  assert.match(out, /<a href="https:\/\/example\.org\/?" target="_blank" rel="noreferrer noopener">Foo<\/a>/);
  assert.match(out, /<b>bold<\/b>/);
  assert.doesNotMatch(out, /<script>/);
});

test('sanitizeCommonsHtml strips javascript: hrefs', () => {
  const out = sanitizeCommonsHtml('<a href="javascript:alert(1)">x</a>');
  assert.doesNotMatch(out, /javascript:/);
});

test('buildThumbnailUrlForWidth substitutes the canonical step', () => {
  const tmpl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Foo.jpg/960px-Foo.jpg';
  assert.equal(
    buildThumbnailUrlForWidth(tmpl, 250),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Foo.jpg/250px-Foo.jpg'
  );
  assert.equal(
    buildThumbnailUrlForWidth(tmpl, 1280),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Foo.jpg/1280px-Foo.jpg'
  );
});

test('buildThumbnailUrlForWidth returns null for unparseable templates', () => {
  assert.equal(buildThumbnailUrlForWidth('https://example/no-step.jpg', 500), null);
  assert.equal(buildThumbnailUrlForWidth(null, 500), null);
  assert.equal(buildThumbnailUrlForWidth('', 500), null);
  assert.equal(buildThumbnailUrlForWidth('https://example/250px-foo.jpg', 0), null);
});

test('synthesizeWikimediaThumbnailTemplate builds raster thumb URL from original', () => {
  // Most common case — JPEG/PNG/GIF original. Both path-hash segments
  // and percent-encoding in the filename should round-trip cleanly.
  assert.equal(
    synthesizeWikimediaThumbnailTemplate(
      'https://upload.wikimedia.org/wikipedia/commons/3/3e/Citroenkruid.jpg',
      960
    ),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Citroenkruid.jpg/960px-Citroenkruid.jpg'
  );
  assert.equal(
    synthesizeWikimediaThumbnailTemplate(
      'https://upload.wikimedia.org/wikipedia/commons/d/d2/Erik_Moeller%2C_cross_processed_portrait.JPG',
      960
    ),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d2/Erik_Moeller%2C_cross_processed_portrait.JPG/960px-Erik_Moeller%2C_cross_processed_portrait.JPG'
  );
});

test('synthesizeWikimediaThumbnailTemplate appends rasterized extension for SVG/PDF', () => {
  // Commons rasterizes SVGs to PNG and PDFs/DJVUs/TIFFs to JPG for
  // thumbnails — the thumb filename gets the extra extension while the
  // path segment keeps the original.
  assert.equal(
    synthesizeWikimediaThumbnailTemplate(
      'https://upload.wikimedia.org/wikipedia/commons/0/0f/Logo.svg',
      500
    ),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/Logo.svg/500px-Logo.svg.png'
  );
  assert.equal(
    synthesizeWikimediaThumbnailTemplate(
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Manuscript.pdf',
      500
    ),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Manuscript.pdf/500px-Manuscript.pdf.jpg'
  );
});

test('synthesizeWikimediaThumbnailTemplate returns null for non-Wikimedia URLs', () => {
  assert.equal(synthesizeWikimediaThumbnailTemplate('https://example.com/foo.jpg', 500), null);
  assert.equal(
    synthesizeWikimediaThumbnailTemplate(
      'https://en.wikipedia.org/wiki/File:Foo.jpg',
      500
    ),
    null
  );
  assert.equal(synthesizeWikimediaThumbnailTemplate(null, 500), null);
  assert.equal(synthesizeWikimediaThumbnailTemplate('', 500), null);
});

test('fetchCommonsMetadata synthesizes template when API returns unscaled original', async () => {
  // Commons returns the unscaled original (no /thumb/, no /<W>px-)
  // when the source image is narrower than `iiurlwidth`. We must
  // synthesize a real thumbnail-template URL so per-display-width
  // substitution works downstream.
  const unscaledResponse = {
    query: {
      pages: [
        {
          pageid: 7777,
          ns: 6,
          title: 'File:Citroenkruid.jpg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Citroenkruid.jpg',
              thumburl:
                'https://upload.wikimedia.org/wikipedia/commons/3/3e/Citroenkruid.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled',
              thumbwidth: 600,
              thumbheight: 450,
              width: 600,
              height: 450,
              mime: 'image/jpeg',
              mediatype: 'BITMAP',
              extmetadata: {
                LicenseShortName: { value: 'CC-BY-SA-4.0' },
              },
            },
          ],
        },
      ],
    },
  };
  const result = await fetchCommonsMetadata('Citroenkruid.jpg', {
    fetchImpl: stubFetch(unscaledResponse),
    apiBaseUrl: 'https://commons.example/w/api.php',
    userAgent: 'TestAgent/1.0',
    timeoutMs: 5000,
  });
  // Synthesised template — has the substitutable `/<W>px-` segment.
  assert.equal(
    result.data.thumbnailUrlTemplate,
    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Citroenkruid.jpg/960px-Citroenkruid.jpg'
  );
  // And it round-trips through buildThumbnailUrlForWidth.
  assert.equal(
    buildThumbnailUrlForWidth(result.data.thumbnailUrlTemplate, 250),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Citroenkruid.jpg/250px-Citroenkruid.jpg'
  );
});

test('fetchCommonsMetadata parses image response with thumbnail template', async () => {
  const result = await fetchCommonsMetadata('Erik Moeller, cross processed portrait.JPG', {
    fetchImpl: stubFetch(buildImageResponse()),
    apiBaseUrl: 'https://commons.example/w/api.php',
    userAgent: 'TestAgent/1.0',
    timeoutMs: 5000,
  });

  assert.equal(result.mediaType, 'image');
  assert.equal(result.data.mime, 'image/jpeg');
  assert.equal(result.data.width, 2400);
  assert.equal(result.data.height, 3200);
  assert.equal(result.data.license, 'CC-BY-SA-3.0');
  assert.equal(result.data.author, 'Erik Möller');
  assert.match(result.data.commonsPageUrl, /\/wiki\/File:Erik_Moeller/);
  // The template URL is what Commons returned at the sample width;
  // storage layer substitutes other widths into it on demand.
  assert.match(result.data.thumbnailUrlTemplate ?? '', /\/960px-/);
  assert.deepEqual(result.data.description, {
    en: 'Cross-processed portrait of Erik Möller.',
  });
});

test('fetchCommonsMetadata throws NotFoundError on missing file', async () => {
  const missing = {
    query: {
      pages: [{ ns: 6, title: 'File:Nope.jpg', missing: true }],
    },
  };
  await assert.rejects(
    fetchCommonsMetadata('Nope.jpg', {
      fetchImpl: stubFetch(missing),
      apiBaseUrl: 'https://commons.example/w/api.php',
      userAgent: 'TestAgent/1.0',
      timeoutMs: 5000,
    }),
    NotFoundError
  );
});

test('fetchCommonsMetadata rejects unsupported mediatype', async () => {
  const unsupported = buildImageResponse();
  unsupported.query.pages[0].imageinfo[0].mediatype = 'OFFICE';
  await assert.rejects(
    fetchCommonsMetadata('Doc.pdf', {
      fetchImpl: stubFetch(unsupported),
      apiBaseUrl: 'https://commons.example/w/api.php',
      userAgent: 'TestAgent/1.0',
      timeoutMs: 5000,
    }),
    (error: unknown) => error instanceof McpToolError && error.code === 'unsupported'
  );
});

test('fetchCommonsMetadata wraps non-OK status as internal_error', async () => {
  await assert.rejects(
    fetchCommonsMetadata('Cat.jpg', {
      fetchImpl: stubFetch({ error: 'rate-limited' }, 503),
      apiBaseUrl: 'https://commons.example/w/api.php',
      userAgent: 'TestAgent/1.0',
      timeoutMs: 5000,
    }),
    (error: unknown) =>
      error instanceof McpToolError &&
      error.code === 'internal_error' &&
      error.retryable === true
  );
});

test('fetchCommonsMetadata returns null thumbnail template for non-image', async () => {
  const audio = buildImageResponse();
  const info = audio.query.pages[0].imageinfo[0] as Record<string, unknown>;
  info.mediatype = 'AUDIO';
  info.mime = 'audio/ogg';
  // Drop thumburl so the template is null.
  info.thumburl = undefined;

  const result = await fetchCommonsMetadata('Foo.ogg', {
    fetchImpl: stubFetch(audio),
    apiBaseUrl: 'https://commons.example/w/api.php',
    userAgent: 'TestAgent/1.0',
    timeoutMs: 5000,
  });

  assert.equal(result.mediaType, 'audio');
  assert.equal(result.data.thumbnailUrlTemplate, null);
});
