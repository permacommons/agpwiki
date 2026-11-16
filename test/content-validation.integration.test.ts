import './_use-database.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createBlogPost } from '../src/services/blog-post-service.js';
import { InvalidRequestError, ValidationError } from '../src/lib/errors.js';
import { createCitation } from '../src/services/citation-service.js';
import { createPageCheck } from '../src/services/page-check-service.js';
import {
  applyWikiPagePatch,
  createWikiPage,
  listWikiPageRevisions,
  updateWikiPage,
} from '../src/services/wiki-page-service.js';
import { createTestUser, getDal } from './_service-fixtures.js';

test('Service rejects invalid language codes', async () => {
  const dal = await getDal();

  const user = await createTestUser();
  const userId = user.id;

  await assert.rejects(
    () =>
      createWikiPage(
        dal,
        {
          slug: `test-lang-${Date.now()}`,
          title: { en: 'Invalid lang' },
          body: { en: 'Body' },
          canonicalLanguage: 'xx',
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'canonicalLanguage'));
      return true;
    }
  );

  await assert.rejects(
    () =>
      applyWikiPagePatch(
        dal,
        {
          slug: 'nonexistent-slug',
          patch: ['--- before', '+++ after', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
          format: 'unified',
          lang: 'xx',
          revSummary: { en: 'Invalid lang patch.' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'lang'));
      return true;
    }
  );

  await assert.rejects(
    () =>
      createBlogPost(
        dal,
        {
          slug: `test-blog-lang-${Date.now()}`,
          title: { en: 'Invalid blog lang' },
          body: { en: 'Body' },
          canonicalLanguage: 'xx',
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'canonicalLanguage'));
      return true;
    }
  );
});

test('Service rejects wiki pages using reserved media routes', async () => {
  const dal = await getDal();
  const slug = `test-reserved-media-route-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await assert.rejects(
    () =>
      createWikiPage(
        dal,
        {
          slug: 'media/example',
          title: { en: 'Reserved media page' },
          body: { en: 'Body' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof InvalidRequestError);
      assert.match(error.message, /reserved/);
      return true;
    }
  );

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Reserved rename source' },
      body: { en: 'Body' },
    },
    userId
  );

  await assert.rejects(
    () =>
      updateWikiPage(
        dal,
        {
          slug,
          newSlug: 'media-files/example/250',
          revSummary: { en: 'Try reserved route rename.' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof InvalidRequestError);
      assert.match(error.message, /reserved/);
      return true;
    }
  );
});

test('Service rejects control characters in wiki content', async () => {
  const dal = await getDal();
  const slug = `test-control-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Control char test' },
      body: { en: 'Safe body.' },
      canonicalLanguage: 'en',
    },
    userId
  );

  await assert.rejects(
    () =>
      updateWikiPage(
        dal,
        {
          slug,
          body: { en: `Contains control char \u001c here.` },
          revSummary: { en: 'Try control char.' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'body.en'));
      return true;
    }
  );
});

test('Service aggregates validation errors for wiki patch inputs', async () => {
  const dal = await getDal();

  const user = await createTestUser();
  const userId = user.id;

  await assert.rejects(
    () =>
      applyWikiPagePatch(
        dal,
        {
          slug: '',
          patch: '',
          format: 'bad' as unknown as 'unified',
          lang: 'xx',
          revSummary: null as unknown as Record<string, string>,
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors);
      assert.ok(error.fieldErrors.length >= 4);
      return true;
    }
  );
});

test('Service rejects unknown citation claim references', async () => {
  const dal = await getDal();
  const slug = `test-claim-ref-${Date.now()}`;
  const citationKey = `test-claim-ref-cite-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createCitation(
    dal,
    {
      key: citationKey,
      data: {
        id: citationKey,
        type: 'webpage',
        title: 'Claim validation test',
        URL: 'https://example.com/claim-validation',
      },
    },
    userId
  );

  await assert.rejects(
    () =>
      createWikiPage(
        dal,
        {
          slug,
          title: { en: 'Claim validation' },
          body: { en: `See [@${citationKey}:missing-claim].` },
          revSummary: { en: 'Add claim reference.' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'body.en'));
      return true;
    }
  );
});

test('Service rejects unknown citation keys', async () => {
  const dal = await getDal();
  const slug = `test-cite-key-${Date.now()}`;
  const citationKey = `test-cite-key-valid-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createCitation(
    dal,
    {
      key: citationKey,
      data: {
        id: citationKey,
        type: 'webpage',
        title: 'Citation key validation test',
        URL: 'https://example.com/citation-key-validation',
      },
    },
    userId
  );

  await assert.rejects(
    () =>
      createWikiPage(
        dal,
        {
          slug,
          title: { en: 'Citation key validation' },
          body: { en: `See [@${citationKey}; @no-such-citation].` },
          revSummary: { en: 'Add citation references.' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'body.en'));
      return true;
    }
  );
});

test('Service rejects unknown citation keys in blog summary', async () => {
  const dal = await getDal();
  const slug = `test-blog-cite-key-${Date.now()}`;
  const citationKey = `test-blog-cite-valid-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createCitation(
    dal,
    {
      key: citationKey,
      data: {
        id: citationKey,
        type: 'webpage',
        title: 'Blog citation key validation test',
        URL: 'https://example.com/blog-citation-key-validation',
      },
    },
    userId
  );

  await assert.rejects(
    () =>
      createBlogPost(
        dal,
        {
          slug,
          title: { en: 'Blog citation key validation' },
          body: { en: 'Body is fine.' },
          summary: { en: `See [@${citationKey}; @no-such-citation].` },
          revSummary: { en: 'Add citation references in summary.' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'summary.en'));
      return true;
    }
  );
});

test('Service rejects unknown citation keys in page check markdown', async () => {
  const dal = await getDal();
  const slug = `test-check-cite-key-${Date.now()}`;
  const citationKey = `test-check-cite-valid-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createCitation(
    dal,
    {
      key: citationKey,
      data: {
        id: citationKey,
        type: 'webpage',
        title: 'Page check citation key validation test',
        URL: 'https://example.com/check-citation-key-validation',
      },
    },
    userId
  );

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Page check citation key validation' },
      body: { en: 'Base article text.' },
      revSummary: { en: 'Create page for check test.' },
    },
    userId
  );
  const revisions = await listWikiPageRevisions(dal, slug);
  const targetRevId = revisions.revisions[0]?.revId;
  assert.ok(targetRevId);

  await assert.rejects(
    () =>
      createPageCheck(
        dal,
        {
          slug,
          type: 'fact_check',
          status: 'issues_found',
          checkResults: { en: `Result cites [@${citationKey}; @no-such-citation].` },
          notes: { en: `Note cites [@${citationKey}; @missing-note-cite].` },
          metrics: {
            issues_found: { high: 1, medium: 0, low: 0 },
            issues_fixed: { high: 0, medium: 0, low: 0 },
          },
          targetRevId,
          revSummary: { en: 'Create check with citation references.' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'checkResults.en'));
      assert.ok(error.fieldErrors?.some(entry => entry.field === 'notes.en'));
      return true;
    }
  );
});

test('Service allows citation-like text in inline code spans', async () => {
  const dal = await getDal();
  const slug = `test-claim-ref-code-${Date.now()}`;
  const citationKey = `test-claim-ref-code-cite-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createCitation(
    dal,
    {
      key: citationKey,
      data: {
        id: citationKey,
        type: 'webpage',
        title: 'Claim validation inline code test',
        URL: 'https://example.com/claim-validation-code',
      },
    },
    userId
  );

  const created = await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Claim validation inline code' },
      body: { en: `Literal \`[@${citationKey}:bad-claim]\` should not validate.` },
      revSummary: { en: 'Add inline code example.' },
    },
    userId
  );
  assert.equal(created.slug, slug);
});

test('Service allows non-citation @key:claim text', async () => {
  const dal = await getDal();
  const slug = `test-claim-ref-plain-${Date.now()}`;
  const citationKey = `test-claim-ref-plain-cite-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createCitation(
    dal,
    {
      key: citationKey,
      data: {
        id: citationKey,
        type: 'webpage',
        title: 'Claim validation plain text test',
        URL: 'https://example.com/claim-validation-plain',
      },
    },
    userId
  );

  const created = await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Claim validation plain text' },
      body: { en: `Reach out to @${citationKey}:bad-claim for details.` },
      revSummary: { en: 'Add plain text example.' },
    },
    userId
  );
  assert.equal(created.slug, slug);
});

test('Service rejects unknown media slugs in wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-media-validation-${Date.now()}`;

  const user = await createTestUser();

  await assert.rejects(
    () =>
      createWikiPage(
        dal,
        {
          slug,
          title: { en: 'Page with bad media ref' },
          body: { en: 'See ![A view](/media/nonexistent-media-slug){size=500}.' },
          canonicalLanguage: 'en',
        },
        user.id
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      const fieldErrors = (error as ValidationError).fieldErrors ?? [];
      assert.ok(
        fieldErrors.some(
          entry =>
            entry.field.includes('body') &&
            entry.message.includes('media not found') &&
            entry.message.includes('nonexistent-media-slug')
        ),
        `Expected media-not-found error, got: ${JSON.stringify(fieldErrors)}`
      );
      return true;
    }
  );
});

test('Service rejects standard markdown image syntax in wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-image-validation-${Date.now()}`;

  const user = await createTestUser();

  // Mimic the agentic-test pattern: agent guesses the embed syntax and
  // produces a body with `![alt](custom-uri-scheme:slug)`. Should be
  // rejected with a hint pointing at the correct `/media/<slug>` form.
  await assert.rejects(
    () =>
      createWikiPage(
        dal,
        {
          slug,
          title: { en: 'Page with the wrong image syntax' },
          body: {
            en: '![A photo of an orchid](agpedia-media:my-orchid?size=500)',
          },
          canonicalLanguage: 'en',
        },
        user.id
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      const fieldErrors = (error as ValidationError).fieldErrors ?? [];
      assert.ok(
        fieldErrors.some(
          entry =>
            entry.field.includes('body') &&
            entry.message.includes('External image URLs are not supported') &&
            entry.message.includes('media_create')
        ),
        `Expected external-url-rejection error, got: ${JSON.stringify(fieldErrors)}`
      );
      return true;
    }
  );

  // External http(s) image URLs are also rejected: every illustration
  // must flow through media_create so license + bytes are tracked.
  await assert.rejects(
    () =>
      createWikiPage(
        dal,
        {
          slug: `${slug}-http`,
          title: { en: 'Page with an external image URL' },
          body: { en: '![banner](https://example.com/banner.png)' },
          canonicalLanguage: 'en',
        },
        user.id
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      const fieldErrors = (error as ValidationError).fieldErrors ?? [];
      assert.ok(
        fieldErrors.some(entry =>
          entry.message.includes('External image URLs are not supported')
        ),
        `Expected external-url-rejection error, got: ${JSON.stringify(fieldErrors)}`
      );
      return true;
    }
  );
});

test('Service rejects unknown media slugs in blog post body', async () => {
  const dal = await getDal();
  const slug = `test-blog-media-ref-${Date.now()}`;

  const user = await createTestUser();

  await assert.rejects(
    () =>
      createBlogPost(
        dal,
        {
          slug,
          title: { en: 'Blog post with bad media ref' },
          body: { en: 'See ![A view](/media/nonexistent-blog-media-slug){size=250}.' },
          summary: { en: 'Summary is fine.' },
          revSummary: { en: 'Add unknown media reference.' },
        },
        user.id
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      const fieldErrors = (error as ValidationError).fieldErrors ?? [];
      assert.ok(
        fieldErrors.some(
          entry =>
            entry.field.includes('body') &&
            entry.message.includes('media not found') &&
            entry.message.includes('nonexistent-blog-media-slug')
        ),
        `Expected media-not-found error, got: ${JSON.stringify(fieldErrors)}`
      );
      return true;
    }
  );
});

test('Service rejects standard markdown image syntax in blog post summary', async () => {
  const dal = await getDal();
  const slug = `test-blog-image-syntax-${Date.now()}`;

  const user = await createTestUser();

  // Wiki has only a body field; blog has both body and summary —
  // so summary coverage is the blog-specific risk surface for the
  // standard-image validator.
  await assert.rejects(
    () =>
      createBlogPost(
        dal,
        {
          slug,
          title: { en: 'Blog post with the wrong image syntax' },
          body: { en: 'Body is fine.' },
          summary: {
            en: '![banner](https://example.com/blog-banner.png)',
          },
          revSummary: { en: 'Add external image URL to summary.' },
        },
        user.id
      ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      const fieldErrors = (error as ValidationError).fieldErrors ?? [];
      assert.ok(
        fieldErrors.some(
          entry =>
            entry.field.includes('summary') &&
            entry.message.includes('External image URLs are not supported') &&
            entry.message.includes('media_create')
        ),
        `Expected external-url-rejection error, got: ${JSON.stringify(fieldErrors)}`
      );
      return true;
    }
  );
});
