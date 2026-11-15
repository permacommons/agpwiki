import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { PoolClient } from 'pg';
import express from 'express';
import { registerPageRoutes } from '../src/routes/pages.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../src/lib/errors.js';
import { WIKI_ADMIN_ROLE, grantRoleUpsert } from '../src/services/roles.js';
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
  replaceWikiPageExactText,
  rewriteWikiPageSection,
  updateWikiPage,
} from '../src/services/wiki-page-service.js';
import { cleanupTestArtifacts, createTestUser, getDal } from './_service-fixtures.js';

test('Service page protection blocks non-admin wiki edits', async () => {
  const dal = await getDal();
  const slug = `test-protected-page-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let adminId: string | null = null;
  let editorId: string | null = null;

  try {
    const admin = await createTestUser();
    const editor = await createTestUser();
    adminId = admin.id;
    editorId = editor.id;
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
    assert.equal(removed?.pageId, page.id);
    assert.equal(await getPageProtectionForPage(dal, page.id), null);
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: editorId ?? undefined,
    });
    await cleanupTestArtifacts(dal, {
      userId: adminId ?? undefined,
    });
  }
});

test('Service issue lists follow the same rules as the notices on articles', async () => {
  const dal = await getDal();
  const stamp = Date.now();
  const prefix = `test-issues-${stamp}`;
  let userId: string | null = null;
  try {
    const user = await createTestUser();
    userId = user.id;
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

    // Other test files add pages meanwhile; one snapshot keeps the counts and lists comparable.
    const client = (await dal.getConnection()) as PoolClient;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = { query: (sql: string, params?: unknown[]) => client.query(sql, params) } as unknown as typeof dal;
      const notChecked = await listArticlesWithIssues(snapshot, { kind: 'unchecked', limit: 500 });
      assert.deepEqual(ours(notChecked), [unchecked.slug]);

      const issues = await listArticlesWithIssues(snapshot, { kind: 'check-issues', limit: 500 });
      assert.deepEqual(ours(issues), [flagged.slug]);
      const flaggedEntry = issues.articles.find(article => article.slug === flagged.slug);
      assert.deepEqual(
        flaggedEntry?.checks?.map(item => [item.type, item.unresolved]),
        [['fact_check', 2]]
      );
      const onlyCopyEdits = await listArticlesWithIssues(snapshot, { kind: 'check-issues', checkType: 'copy_edit', limit: 500 });
      assert.deepEqual(ours(onlyCopyEdits), []);

      const noWikidata = await listArticlesWithIssues(snapshot, { kind: 'no-wikidata', limit: 500 });
      assert.deepEqual(ours(noWikidata), [unchecked.slug]);

      const counts = await countArticlesWithIssues(snapshot);
      assert.equal(counts.unchecked, notChecked.total);
      assert.equal(counts['check-issues'], issues.total);
      assert.equal(counts['no-wikidata'], noWikidata.total);

      const paged = await listArticlesWithIssues(snapshot, { kind: 'no-wikidata', limit: 1, offset: 0 });
      assert.equal(paged.articles.length, 1);
      assert.equal(paged.total, noWikidata.total);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await dal.query(
      'DELETE FROM page_checks WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
      [`${prefix}%`]
    );
    await cleanupTestArtifacts(dal, { slugPrefix: `${prefix}%`, userId: userId ?? undefined });
  }
});

test('Article footer uses the selected revision Wikidata ID', async () => {
  const dal = await getDal();
  const slug = `test-wikidata-footer-${Date.now()}`;
  let userId: string | null = null;
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
    userId = user.id;
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
    await cleanupTestArtifacts(dal, { slugPrefix: `${slug}%`, userId: userId ?? undefined });
  }
});

test('Service wiki pages record a versioned Wikidata ID', async () => {
  const dal = await getDal();
  const slug = `test-wikidata-id-${Date.now()}`;
  let userId: string | null = null;

  try {
    const user = await createTestUser();
    userId = user.id;

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
  } finally {
    await cleanupTestArtifacts(dal, { slugPrefix: `${slug}%`, userId: userId ?? undefined });
  }
});

test('Service auth + wiki create/update writes revisions', async () => {
  const dal = await getDal();
  const slug = `test-mcp-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;

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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service readWikiPage returns a stable content hash that changes on update', async () => {
  const dal = await getDal();
  const slug = `test-mcp-content-hash-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service updateWikiPage preserves other localized entries', async () => {
  const dal = await getDal();
  const slug = `test-page-localized-update-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service apply patch updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-patch-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service rewrite section updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-rewrite-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service rewrite section supports lead target', async () => {
  const dal = await getDal();
  const slug = `test-mcp-rewrite-lead-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service replace exact text applies multiple unique replacements atomically', async () => {
  const dal = await getDal();
  const slug = `test-mcp-replace-exact-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service replace exact text rejects ambiguous replacements without partial edits', async () => {
  const dal = await getDal();
  const slug = `test-mcp-replace-exact-ambiguous-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service deleteWikiPage soft-deletes a page', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-page-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('findExistingWikiLinkSlugs ignores aliases of deleted pages', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-alias-page-${Date.now()}`;
  const aliasSlug = `${slug}-alias`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('Service deleteWikiPage requires wiki_admin role', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-page-forbidden-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
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
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});
