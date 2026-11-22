import './_use-database.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { registerPageRoutes } from '../src/routes/pages.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/lib/errors.js';
import { SITE_ADMIN_ROLE, WIKI_ADMIN_ROLE, grantRoleUpsert } from '../src/services/roles.js';
import { findExistingWikiLinkSlugs } from '../src/services/wiki-link-preview-service.js';
import { createPageCheck } from '../src/services/page-check-service.js';
import { countArticlesWithIssues, listArticlesWithIssues } from '../src/services/article-issues-service.js';
import { getPageProtectionForPage, protectWikiPage, unprotectWikiPage } from '../src/services/page-protection-service.js';
import { listRecentAdminEvents } from '../src/services/admin-event-service.js';
import {
  addWikiPageAlias,
  listPagesMissingWikidata,
  readWikiPageRevision,
  applyWikiPagePatch,
  createWikiPage,
  deleteWikiPage,
  listWikiPageRevisions,
  readWikiPage,
  removeWikiPageAlias,
  replaceWikiPageExactText,
  rewriteWikiPageSection,
  updateWikiPage,
} from '../src/services/wiki-page-service.js';
import { createTestUser, getDal } from './_service-fixtures.js';

test('Service page protection blocks non-admin wiki edits', async () => {
  const dal = await getDal();
  const slug = `test-protected-page-${Date.now()}`;

  const admin = await createTestUser();
  const editor = await createTestUser();
  await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);

  const page = await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Protected Page' },
      body: { en: 'Original text.' },
      canonicalLanguage: 'en',
    },
    editor.id
  );

  const protection = await protectWikiPage(
    dal,
    { slug: `/${slug}`, reason: 'Prompt injection mitigation.' },
    admin.id
  );
  assert.equal(protection.pageId, page.id);

  await assert.rejects(
    () =>
      updateWikiPage(
        dal,
        {
          slug,
          body: { en: 'Non-admin edit.' },
          revSummary: { en: 'Try edit.' },
        },
        editor.id
      ),
    ForbiddenError
  );

  const patch = [
    '--- before',
    '+++ after',
    '@@ -1 +1 @@',
    '-Original text.',
    '+Patched text.',
  ].join('\n');
  await assert.rejects(
    () =>
      applyWikiPagePatch(
        dal,
        {
          slug,
          patch,
          format: 'unified',
          lang: 'en',
          revSummary: { en: 'Try patch.' },
        },
        editor.id
      ),
    ForbiddenError
  );

  const updated = await updateWikiPage(
    dal,
    {
      slug,
      body: { en: 'Admin edit.' },
      revSummary: { en: 'Admin edit protected page.' },
    },
    admin.id
  );
  assert.equal(updated.body?.en, 'Admin edit.');

  const patched = await applyWikiPagePatch(dal, {
    slug,
    patch: '--- before\n+++ after\n@@ -1 +1 @@\n-Admin edit.\n+Patched text.',
    format: 'unified',
    baseRevId: updated.currentRevId,
    tags: ['custom-edit'],
    revSummary: { en: 'Patch protected page.' },
  }, admin.id);
  const rewritten = await rewriteWikiPageSection(dal, {
    slug,
    target: 'lead',
    content: 'Rewritten text.',
    expectedRevId: patched.currentRevId,
    tags: ['custom-edit'],
    revSummary: { en: 'Rewrite protected page.' },
  }, admin.id);
  const replaced = await replaceWikiPageExactText(dal, {
    slug,
    replacements: [{ from: 'Rewritten', to: 'Replaced' }],
    expectedRevId: rewritten.currentRevId,
    tags: ['custom-edit'],
    revSummary: { en: 'Replace protected text.' },
  }, admin.id);
  assert.equal(replaced.body?.en, 'Replaced text.');

  const editEvents = await dal.query(
    "SELECT target_rev_id, details FROM admin_events WHERE target_id = $1 AND event_type = 'protected_wiki_page_edited'",
    [page.id]
  );
  for (const [result, operation, summary] of [
    [updated, 'update', 'Admin edit protected page.'],
    [patched, 'patch', 'Patch protected page.'],
    [rewritten, 'rewrite-section', 'Rewrite protected page.'],
    [replaced, 'replace-exact', 'Replace protected text.'],
  ] as const) {
    const { revision } = await readWikiPageRevision(dal, slug, result.currentRevId);
    assert.ok(revision);
    assert.deepEqual(revision.revSummary, { en: summary });
    assert.ok(revision.revTags?.includes('update'));
    if (operation !== 'update') {
      assert.ok(revision.revTags?.includes(operation));
      assert.ok(revision.revTags?.includes('custom-edit'));
    }
    assert.ok(editEvents.rows.some(event =>
      event.target_rev_id === result.currentRevId && event.details.operation === operation
    ));
  }

  const events = await listRecentAdminEvents(dal, 10);
  assert.ok(events.some(event => event.eventType === 'wiki_page_protected'));
  assert.ok(events.length <= 10);
  assert.deepEqual(events, [...events].sort((a, b) =>
    b.createdAt!.getTime() - a.createdAt!.getTime() || b.id.localeCompare(a.id)
  ));
  assert.equal((await listRecentAdminEvents(dal, 1)).length, 1);
  assert.ok(events.some(event => event.eventType === 'protected_wiki_page_edited'));

  const removed = await unprotectWikiPage(dal, { slug: `/${slug}`, reason: 'Done.' }, admin.id);
  assert.equal(removed.protection?.pageId, page.id);
  assert.equal(removed.protected, false);
  assert.equal(removed.removed, true);
  assert.equal(await getPageProtectionForPage(dal, page.id), null);
});

test('Service issue lists follow the same rules as the notices on articles', async () => {
  const dal = await getDal();
  const stamp = Date.now();
  const prefix = `test-issues-${stamp}`;
  const user = await createTestUser();
  const make = (name: string, wikidata?: string) =>
    createWikiPage(dal, { slug: `${prefix}-${name}`, title: { en: name }, body: { en: 'Text.' }, wikidata }, user.id);
  const unchecked = await make('unchecked');
  const flagged = await make('flagged', 'Q42');
  const clean = await make('clean', 'Q43');
  const check = (page: { slug: string; currentRevId: string }, high: number, fixed: number, type = 'fact_check') =>
    createPageCheck(
      dal,
      {
        slug: page.slug,
        type,
        status: 'completed',
        checkResults: { en: 'Checked.' },
        metrics: {
          issues_found: { high, medium: 0, low: 0 },
          issues_fixed: { high: fixed, medium: 0, low: 0 },
        },
        targetRevId: page.currentRevId,
        revSummary: { en: 'Check.' },
      },
      user.id
    );
  await check(flagged, 2, 0);
  await check(clean, 1, 1, 'copy_edit');

  const ours = (list: { articles: Array<{ slug: string }> }) =>
    list.articles.map(article => article.slug).filter(slug => slug.startsWith(prefix)).sort();

  const notChecked = await listArticlesWithIssues(dal, { kind: 'unchecked', limit: 500 });
  assert.deepEqual(ours(notChecked), [unchecked.slug]);

  const issues = await listArticlesWithIssues(dal, { kind: 'check-issues', limit: 500 });
  assert.deepEqual(ours(issues), [flagged.slug]);
  const flaggedEntry = issues.articles.find(article => article.slug === flagged.slug);
  assert.deepEqual(
    flaggedEntry?.checks?.map(item => [item.type, item.unresolved]),
    [['fact_check', 2]]
  );
  const onlyCopyEdits = await listArticlesWithIssues(dal, { kind: 'check-issues', checkType: 'copy_edit', limit: 500 });
  assert.deepEqual(ours(onlyCopyEdits), []);

  const noWikidata = await listArticlesWithIssues(dal, { kind: 'no-wikidata', limit: 500 });
  assert.deepEqual(ours(noWikidata), [unchecked.slug]);

  const counts = await countArticlesWithIssues(dal);
  assert.equal(counts.unchecked, notChecked.total);
  assert.equal(counts['check-issues'], issues.total);
  assert.equal(counts['no-wikidata'], noWikidata.total);

  const paged = await listArticlesWithIssues(dal, { kind: 'no-wikidata', limit: 1, offset: 0 });
  assert.equal(paged.articles.length, 1);
  assert.equal(paged.total, noWikidata.total);
});

test('Article footer uses the selected revision Wikidata ID', async () => {
  const dal = await getDal();
  const slug = `test-wikidata-footer-${Date.now()}`;
  const app = express();
  app.use((req, res, next) => {
    req.t = ((key: string) => key) as typeof req.t;
    res.locals.locale = 'en';
    res.locals.languageOptions = [];
    res.locals.accountBannerHtml = '';
    res.render = ((_view: string, options?: Record<string, unknown>) => {
      res.json({ bodyHtml: options?.bodyHtml });
    }) as express.Response['render'];
    next();
  });
  registerPageRoutes(app);
  const server = http.createServer(app);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/${slug}`;
    const assertFooter = async (
      revId: string | null,
      wikidata: string | null,
      fromRevId?: string,
      expectedBody?: string
    ) => {
      const query = fromRevId
        ? `?diffFrom=${fromRevId}&diffTo=${revId}`
        : revId ? `?rev=${revId}` : '';
      const response = await fetch(`${url}${query}`);
      assert.equal(response.status, 200);
      const { bodyHtml } = (await response.json()) as { bodyHtml: string };
      if (expectedBody) assert.ok(bodyHtml.includes(`<p>${expectedBody}</p>`));
      if (wikidata) {
        assert.match(
          bodyHtml,
          new RegExp(`<p class="page-wikidata">.*href="https://www\\.wikidata\\.org/wiki/${wikidata}"[^>]*>${wikidata}</a></p>`)
        );
      } else {
        assert.doesNotMatch(bodyHtml, /class="page-wikidata"/);
      }
    };

    const user = await createTestUser();
    const created = await createWikiPage(
      dal,
      { slug, title: { en: 'Wikidata footer' }, body: { en: 'Text.' } },
      user.id
    );
    const historical = await updateWikiPage(
      dal,
      { slug, body: { en: 'Historical body.' }, revSummary: { en: 'Edit body.' } },
      user.id
    );
    const added = await updateWikiPage(
      dal,
      { slug, body: { en: 'Current body.' }, wikidata: 'Q42', revSummary: { en: 'Add Wikidata ID.' } },
      user.id
    );
    await assertFooter(null, 'Q42');
    await assertFooter(created.currentRevId, null);
    await assertFooter(historical.currentRevId, null, created.currentRevId, 'Historical body.');

    await updateWikiPage(
      dal,
      { slug, wikidata: 'Q698', revSummary: { en: 'Change Wikidata ID.' } },
      user.id
    );
    await assertFooter(null, 'Q698');
    await assertFooter(added.currentRevId, 'Q42');
    await assertFooter(added.currentRevId, 'Q42', historical.currentRevId, 'Current body.');

    await updateWikiPage(
      dal,
      { slug, wikidata: null, revSummary: { en: 'Remove Wikidata ID.' } },
      user.id
    );
    await assertFooter(null, null);
    await assertFooter(added.currentRevId, 'Q42');
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  }
});

test('Service wiki pages record a versioned Wikidata ID', async () => {
  const dal = await getDal();
  const slug = `test-wikidata-id-${Date.now()}`;

  const user = await createTestUser();

  await assert.rejects(
    () =>
      createWikiPage(
        dal,
        { slug, title: { en: 'Bad' }, body: { en: 'Text.' }, wikidata: 'Firefox' },
        user.id
      ),
    ValidationError
  );

  const created = await createWikiPage(
    dal,
    { slug, title: { en: 'Firefox test' }, body: { en: 'Text.' }, wikidata: 'Q698' },
    user.id
  );
  assert.equal(created.wikidata, 'Q698');
  assert.equal((await readWikiPage(dal, slug)).wikidata, 'Q698');

  const missingBefore = await listPagesMissingWikidata(dal);
  assert.equal(missingBefore.some(page => page.slug === slug), false);

  const changed = await updateWikiPage(
    dal,
    { slug, wikidata: 'Q699', revSummary: { en: 'Fix Wikidata ID.' } },
    user.id
  );
  assert.equal(changed.wikidata, 'Q699');

  const bodyOnly = await updateWikiPage(
    dal,
    { slug, body: { en: 'New text.' }, revSummary: { en: 'Edit text.' } },
    user.id
  );
  assert.equal(bodyOnly.wikidata, 'Q699');

  const removed = await updateWikiPage(
    dal,
    { slug, wikidata: null, revSummary: { en: 'Remove Wikidata ID.' } },
    user.id
  );
  assert.equal(removed.wikidata, null);
  assert.equal((await listPagesMissingWikidata(dal)).some(page => page.slug === slug), true);

  const first = await readWikiPageRevision(dal, slug, created.currentRevId);
  assert.equal(first.revision.wikidata, 'Q698');
});

test('Service auth + wiki create/update writes revisions', async () => {
  const dal = await getDal();
  const slug = `test-mcp-${Date.now()}`;

  const user = await createTestUser();

  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'MCP Test' },
      body: { en: 'Initial content.' },
      canonicalLanguage: 'en',
    },
    userId,
  );

  await updateWikiPage(
    dal,
    {
      slug,
      body: { en: 'Updated content.' },
      revSummary: { en: 'Update content.' },
    },
    userId,
  );

  const revisions = await listWikiPageRevisions(dal, slug);
  assert.equal(revisions.pageId.length > 0, true);
  assert.ok(revisions.revisions.length >= 2);
  assert.ok(revisions.revisions.every(rev => rev.revUser === userId));
});

test('Service readWikiPage returns a stable content hash that changes on update', async () => {
  const dal = await getDal();
  const slug = `test-mcp-content-hash-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Hash Test' },
      body: { en: 'Initial content.' },
      canonicalLanguage: 'en',
    },
    userId
  );

  const firstRead = await readWikiPage(dal, slug);
  const secondRead = await readWikiPage(dal, slug);
  assert.match(firstRead.currentRevId, /^[0-9a-f-]{36}$/);
  assert.equal(firstRead.contentHash.length, 64);
  assert.equal(firstRead.contentHash, secondRead.contentHash);
  assert.equal(firstRead.currentRevId, secondRead.currentRevId);

  await updateWikiPage(
    dal,
    {
      slug,
      body: { en: 'Updated content.' },
      revSummary: { en: 'Update hash source.' },
    },
    userId
  );

  const updatedRead = await readWikiPage(dal, slug);
  assert.notEqual(updatedRead.contentHash, firstRead.contentHash);
  assert.notEqual(updatedRead.currentRevId, firstRead.currentRevId);
});

test('Service updateWikiPage preserves other localized entries', async () => {
  const dal = await getDal();
  const slug = `test-page-localized-update-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Original English title', fr: 'Titre francais original' },
      body: { en: 'English body.', fr: 'Corps francais original.' },
      canonicalLanguage: 'en',
    },
    userId
  );

  await updateWikiPage(
    dal,
    {
      slug,
      title: { fr: 'Titre francais mis a jour' },
      body: { fr: 'Corps francais mis a jour.' },
      revSummary: { fr: 'Mettre a jour la version francaise.' },
    },
    userId
  );

  const page = await readWikiPage(dal, slug);
  assert.equal(page.title?.en, 'Original English title');
  assert.equal(page.title?.fr, 'Titre francais mis a jour');
  assert.equal(page.body?.en, 'English body.');
  assert.equal(page.body?.fr, 'Corps francais mis a jour.');
});

test('Service apply patch updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-patch-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Patch Test' },
      body: { en: 'Hello old world' },
      canonicalLanguage: 'en',
    },
    userId
  );

  const patch = [
    '--- before',
    '+++ after',
    '@@ -1 +1 @@',
    '-Hello old world',
    '+Hello new world',
  ].join('\n');

  const result = await applyWikiPagePatch(
    dal,
    {
      slug,
      patch,
      format: 'unified',
      lang: 'en',
      revSummary: { en: 'Patch update.' },
    },
    userId
  );

  assert.equal(result.body?.en, 'Hello new world');
});

test('Service rewrite section updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-rewrite-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  const originalBody = [
    '# Title',
    '',
    '## History',
    'Old line',
    '',
    '## Details',
    'More text',
  ].join('\n');

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Rewrite Test' },
      body: { en: originalBody },
      canonicalLanguage: 'en',
    },
    userId
  );

  const result = await rewriteWikiPageSection(
    dal,
    {
      slug,
      heading: 'History',
      content: 'New line',
      lang: 'en',
      revSummary: { en: 'Rewrite section.' },
    },
    userId
  );

  const expectedBody = [
    '# Title',
    '',
    '## History',
    'New line',
    '',
    '## Details',
    'More text',
  ].join('\n');

  assert.equal(result.body?.en, expectedBody);
});

test('Service rewrite section supports lead target', async () => {
  const dal = await getDal();
  const slug = `test-mcp-rewrite-lead-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  const originalBody = ['Lead paragraph.', '', '## History', 'Old line'].join('\n');

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Rewrite Lead Test' },
      body: { en: originalBody },
      canonicalLanguage: 'en',
    },
    userId
  );

  const result = await rewriteWikiPageSection(
    dal,
    {
      slug,
      target: 'lead',
      content: 'Updated lead paragraph.',
      lang: 'en',
      revSummary: { en: 'Rewrite lead section.' },
    },
    userId
  );

  const expectedBody = ['Updated lead paragraph.', '', '## History', 'Old line'].join('\n');
  assert.equal(result.body?.en, expectedBody);
});

test('Service replace exact text applies multiple unique replacements atomically', async () => {
  const dal = await getDal();
  const slug = `test-mcp-replace-exact-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Replace Exact Test' },
      body: { en: 'foo and bla' },
      canonicalLanguage: 'en',
    },
    userId
  );

  const result = await replaceWikiPageExactText(
    dal,
    {
      slug,
      replacements: [
        { from: 'foo', to: 'bar' },
        { from: 'bla', to: 'boo' },
      ],
      lang: 'en',
      revSummary: { en: 'Replace exact text.' },
    },
    userId
  );

  assert.equal(result.body?.en, 'bar and boo');
});

test('Service replace exact text rejects ambiguous replacements without partial edits', async () => {
  const dal = await getDal();
  const slug = `test-mcp-replace-exact-ambiguous-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Replace Exact Ambiguous Test' },
      body: { en: 'foo and bla and bla' },
      canonicalLanguage: 'en',
    },
    userId
  );

  await assert.rejects(
    () =>
      replaceWikiPageExactText(
        dal,
        {
          slug,
          replacements: [
            { from: 'foo', to: 'bar' },
            { from: 'bla', to: 'boo' },
          ],
          lang: 'en',
          revSummary: { en: 'Reject ambiguous replacements.' },
        },
        userId
      ),
    error => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'Exact text occurs more than once: "bla". Refusing to apply partial replacement.'
      );
      return true;
    }
  );

  const page = await readWikiPage(dal, slug);
  assert.equal(page.body?.en, 'foo and bla and bla');
});

test('Service deleteWikiPage soft-deletes a page', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-page-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Page to Delete' },
      body: { en: 'Content to delete.' },
      canonicalLanguage: 'en',
    },
    userId
  );

  const readBefore = await readWikiPage(dal, slug);
  assert.equal(readBefore.slug, slug);
  await grantRoleUpsert(dal, userId, WIKI_ADMIN_ROLE);

  const deleteResult = await deleteWikiPage(
    dal,
    { slug, revSummary: { en: 'Admin deletion.' } },
    userId
  );

  assert.equal(deleteResult.deleted, true);
  assert.equal(deleteResult.slug, slug);
  const pageDeleteRow = await dal.query(
    'SELECT _rev_summary FROM pages WHERE slug = $1 AND _old_rev_of IS NULL AND _rev_deleted = true',
    [slug]
  );
  assert.equal(pageDeleteRow.rowCount, 1);
  assert.deepEqual(
    (pageDeleteRow.rows[0] as { _rev_summary: Record<string, string> | null })._rev_summary,
    { en: 'Admin deletion.' }
  );

  await assert.rejects(
    () => readWikiPage(dal, slug),
    error => {
      assert.ok(error instanceof NotFoundError);
      return true;
    }
  );
});

test('findExistingWikiLinkSlugs ignores aliases of deleted pages', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-alias-page-${Date.now()}`;
  const aliasSlug = `${slug}-alias`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Page with Alias' },
      body: { en: 'Content to delete.' },
      canonicalLanguage: 'en',
    },
    userId
  );

  await addWikiPageAlias(
    dal,
    {
      pageSlug: slug,
      slug: aliasSlug,
    },
    userId
  );

  const existingBeforeDelete = await findExistingWikiLinkSlugs(dal, [aliasSlug]);
  assert.deepEqual([...existingBeforeDelete], [aliasSlug]);

  await grantRoleUpsert(dal, userId, WIKI_ADMIN_ROLE);
  await deleteWikiPage(
    dal,
    { slug, revSummary: { en: 'Admin deletion.' } },
    userId
  );

  const existingAfterDelete = await findExistingWikiLinkSlugs(dal, [aliasSlug]);
  assert.deepEqual([...existingAfterDelete], []);
});

test('Service deleteWikiPage requires wiki_admin role', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-page-forbidden-${Date.now()}`;

  const user = await createTestUser();
  const userId = user.id;

  await createWikiPage(
    dal,
    {
      slug,
      title: { en: 'Page to Delete (Forbidden)' },
      body: { en: 'Content to delete.' },
      canonicalLanguage: 'en',
    },
    userId
  );

  await assert.rejects(
    () => deleteWikiPage(dal, { slug, revSummary: { en: 'Admin deletion.' } }, userId),
    error => {
      assert.ok(error instanceof ForbiddenError);
      return true;
    }
  );
});

test('Privacy page mutations require site admin rights through canonical and alias addresses', async () => {
  const dal = await getDal();
  const siteAdmin = await createTestUser();
  const wikiAdmin = await createTestUser();
  await grantRoleUpsert(dal, siteAdmin.id, SITE_ADMIN_ROLE);
  await grantRoleUpsert(dal, wikiAdmin.id, WIKI_ADMIN_ROLE);

  const input = {
    slug: '/Meta/Privacy/',
    title: { en: 'Privacy policy' },
    body: { en: 'Original policy.' },
  };
  const siteAdminRequired = (error: unknown) =>
    error instanceof ForbiddenError && error.details?.requiredRole === SITE_ADMIN_ROLE;
  await assert.rejects(createWikiPage(dal, input, wikiAdmin.id), siteAdminRequired);
  const otherPage = await createWikiPage(dal, {
    slug: 'unrestricted-policy-example',
    title: { en: 'Unrestricted policy example' },
    body: { en: 'Example text.' },
  }, wikiAdmin.id);
  await assert.rejects(
    updateWikiPage(dal, {
      slug: otherPage.slug, newSlug: input.slug, revSummary: { en: 'Move page.' },
    }, wikiAdmin.id),
    siteAdminRequired
  );
  await assert.rejects(
    addWikiPageAlias(dal, { slug: input.slug, pageSlug: otherPage.slug }, wikiAdmin.id),
    siteAdminRequired
  );
  const page = await createWikiPage(dal, input, siteAdmin.id);

  const edit = { body: { en: 'Revised policy.' }, revSummary: { en: 'Update policy.' } };
  await addWikiPageAlias(dal, { slug: 'privacy-policy-alias', pageSlug: page.slug }, siteAdmin.id);
  await assert.rejects(
    updateWikiPage(dal, { slug: 'privacy-policy-alias', ...edit }, wikiAdmin.id),
    siteAdminRequired
  );
  await assert.rejects(protectWikiPage(dal, { slug: 'privacy-policy-alias' }, wikiAdmin.id), siteAdminRequired);
  await assert.rejects(unprotectWikiPage(dal, { slug: page.slug }, wikiAdmin.id), siteAdminRequired);
  await assert.rejects(
    deleteWikiPage(dal, { slug: 'privacy-policy-alias', revSummary: edit.revSummary }, wikiAdmin.id),
    siteAdminRequired
  );

  const moved = await updateWikiPage(
    dal, { slug: page.slug, newSlug: 'meta/renamed-privacy-policy', ...edit }, siteAdmin.id
  );
  await assert.rejects(updateWikiPage(dal, { slug: moved.slug, ...edit }, wikiAdmin.id), siteAdminRequired);
  await assert.rejects(removeWikiPageAlias(dal, '/meta/privacy/', wikiAdmin.id), siteAdminRequired);
  await assert.rejects(removeWikiPageAlias(dal, 'privacy-policy-alias', wikiAdmin.id), siteAdminRequired);
  assert.equal((await readWikiPage(dal, '/meta/privacy/')).id, page.id);
});
