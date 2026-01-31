import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import { initializePostgreSQL } from '../src/db.js';
import { resolveAuthUserId } from '../src/mcp/auth.js';
import { createBlogPost } from '../src/mcp/blog-handlers.js';
import { createMcpServer } from '../src/mcp/core.js';
import { NotFoundError, ValidationError } from '../src/mcp/errors.js';
import {
  applyWikiPagePatch,
  createCitation,
  createWikiPage,
  deleteCitation,
  deleteWikiPage,
  listWikiPageRevisions,
  readCitation,
  readWikiPage,
  rewriteWikiPageSection,
  updateWikiPage,
} from '../src/mcp/handlers.js';
import { WIKI_ADMIN_ROLE } from '../src/mcp/roles.js';
import ApiToken from '../src/models/api-token.js';
import User from '../src/models/user.js';
import { renderMarkdown } from '../src/render.js';

const generateToken = () => `agp_${randomBytes(24).toString('hex')}`;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | null = null;

const getDal = async () => {
  if (sharedDal) return sharedDal;
  sharedDal = await initializePostgreSQL();
  return sharedDal;
};

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const createTestUser = async (dal: Awaited<ReturnType<typeof initializePostgreSQL>>) => {
  const email = `mcp-test-${Date.now()}@example.com`;
  const user = await User.create({
    displayName: 'MCP Test',
    email,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });

  const token = generateToken();
  await ApiToken.create({
    userId: user.id,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 8),
    label: 'integration-test',
    createdAt: new Date(),
  });

  return { user, token };
};

const cleanupTestArtifacts = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  {
    slugPrefix,
    citationPrefix,
    userId,
  }: { slugPrefix?: string; citationPrefix?: string; userId?: string }
) => {
  if (slugPrefix) {
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [slugPrefix]);
  }
  if (citationPrefix) {
    await dal.query('DELETE FROM citations WHERE key LIKE $1', [citationPrefix]);
  }
  if (userId) {
    await dal.query('DELETE FROM api_tokens WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

test('MCP auth + wiki create/update writes revisions', async () => {
  const dal = await getDal();
  const slug = `test-mcp-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;

    const userId = await resolveAuthUserId();
    assert.equal(userId, user.id);

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'MCP Test' },
        body: { en: 'Initial content.' },
        originalLanguage: 'en',
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
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP apply patch updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-patch-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Patch Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
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
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP rewrite section updates wiki page body', async () => {
  const dal = await getDal();
  const slug = `test-mcp-rewrite-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

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
        originalLanguage: 'en',
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
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('renderMarkdown includes bibliography entries for citations', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Agpedia Test Citation',
          URL: 'https://example.com/test-citation',
          accessed: {
            'date-parts': [[2024, 1, 1]],
          },
        },
      },
      userId
    );

    const { html } = await renderMarkdown(`Testing [@${citationKey}].`, [citation.data ?? {}]);
    assert.match(html, /Agpedia Test Citation/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('renderMarkdown supports adjacent bracket citations', async () => {
  const dal = await getDal();
  const citationBase = `test-cite-adj-${Date.now()}`;
  const citationPrefix = `${citationBase}%`;
  const citationKeyA = `${citationBase}-a`;
  const citationKeyB = `${citationBase}-b`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    const citationA = await createCitation(
      dal,
      {
        key: citationKeyA,
        data: {
          id: citationKeyA,
          type: 'webpage',
          title: 'Adjacent Citation A',
          URL: 'https://example.com/adjacent-a',
          accessed: {
            'date-parts': [[2024, 1, 1]],
          },
        },
      },
      userId
    );

    const citationB = await createCitation(
      dal,
      {
        key: citationKeyB,
        data: {
          id: citationKeyB,
          type: 'webpage',
          title: 'Adjacent Citation B',
          URL: 'https://example.com/adjacent-b',
          accessed: {
            'date-parts': [[2024, 1, 1]],
          },
        },
      },
      userId
    );

    const { html } = await renderMarkdown(
      `Testing [@${citationKeyA}][@${citationKeyB}].`,
      [citationA.data ?? {}, citationB.data ?? {}]
    );

    assert.equal((html.match(/citation-group/g) ?? []).length, 2);
    assert.doesNotMatch(html, /\[\s*<span class="citation-group">/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('renderMarkdown punctuation handles author-only citations without year', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-noyear-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    const citation = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Sandbox citation with no year',
          author: [{ family: 'Tester', given: 'Alex' }],
          URL: 'https://example.com/sandbox-citation',
        },
      },
      userId
    );

    const { html } = await renderMarkdown(`Testing [@${citationKey}].`, [citation.data ?? {}]);
    assert.match(html, /Tester, Alex\. Sandbox citation with no year\./);
    assert.doesNotMatch(html, /AlexSandbox/);
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP rejects invalid language codes', async () => {
  const dal = await getDal();
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    await assert.rejects(
      () =>
        createWikiPage(
          dal,
          {
            slug: `test-lang-${Date.now()}`,
            title: { en: 'Invalid lang' },
            body: { en: 'Body' },
            originalLanguage: 'xx',
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'originalLanguage'));
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
            originalLanguage: 'xx',
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'originalLanguage'));
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP rejects control characters in wiki content', async () => {
  const dal = await getDal();
  const slug = `test-control-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Control char test' },
        body: { en: 'Safe body.' },
        originalLanguage: 'en',
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
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP aggregates validation errors for wiki patch inputs', async () => {
  const dal = await getDal();
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

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
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP deleteWikiPage soft-deletes a page', async () => {
  const dal = await getDal();
  const slug = `test-mcp-delete-page-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Page to Delete' },
        body: { en: 'Content to delete.' },
        originalLanguage: 'en',
      },
      userId
    );

    const readBefore = await readWikiPage(dal, slug);
    assert.equal(readBefore.slug, slug);

    const deleteResult = await deleteWikiPage(
      dal,
      { slug, revSummary: { en: 'Admin deletion.' } },
      userId
    );

    assert.equal(deleteResult.deleted, true);
    assert.equal(deleteResult.slug, slug);

    await assert.rejects(
      () => readWikiPage(dal, slug),
      error => {
        assert.ok(error instanceof NotFoundError);
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP deleteCitation soft-deletes a citation', async () => {
  const dal = await getDal();
  const citationKey = `test-delete-cite-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: citationKey,
          type: 'webpage',
          title: 'Citation to Delete',
          URL: 'https://example.com/delete-test',
        },
      },
      userId
    );

    const readBefore = await readCitation(dal, citationKey);
    assert.equal(readBefore.key, citationKey);

    const deleteResult = await deleteCitation(
      dal,
      { key: citationKey, revSummary: { en: 'Admin deletion.' } },
      userId
    );

    assert.equal(deleteResult.deleted, true);
    assert.equal(deleteResult.key, citationKey);

    await assert.rejects(
      () => readCitation(dal, citationKey),
      error => {
        assert.ok(error instanceof NotFoundError);
        return true;
      }
    );
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        citationPrefix,
        userId: userIdForCleanup ?? undefined,
      });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
    delete process.env.AGPWIKI_MCP_TOKEN;
  }
});

test('MCP admin tools are disabled without wiki_admin role', () => {
  const mcpWithoutRole = createMcpServer({ userRoles: [] });
  assert.ok(mcpWithoutRole.adminTools.wikiDeletePageTool);
  assert.ok(mcpWithoutRole.adminTools.citationDeleteTool);

  assert.equal(mcpWithoutRole.adminTools.wikiDeletePageTool.enabled, false);
  assert.equal(mcpWithoutRole.adminTools.citationDeleteTool.enabled, false);
});

test('MCP admin tools are enabled with wiki_admin role', () => {
  const mcpWithRole = createMcpServer({ userRoles: [WIKI_ADMIN_ROLE] });
  assert.ok(mcpWithRole.adminTools.wikiDeletePageTool);
  assert.ok(mcpWithRole.adminTools.citationDeleteTool);

  assert.equal(mcpWithRole.adminTools.wikiDeletePageTool.enabled, true);
  assert.equal(mcpWithRole.adminTools.citationDeleteTool.enabled, true);
});
