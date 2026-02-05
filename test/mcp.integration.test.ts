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
  createCitationClaim,
  createCitation,
  createWikiPage,
  readCitationClaim,
  deleteCitation,
  deleteWikiPage,
  listWikiPageRevisions,
  readCitation,
  readWikiPage,
  replaceWikiPageExactText,
  rewriteWikiPageSection,
  updateCitationClaim,
  updateCitation,
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
    claimPrefix,
    userId,
  }: { slugPrefix?: string; citationPrefix?: string; claimPrefix?: string; userId?: string }
) => {
  if (slugPrefix) {
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [slugPrefix]);
  }
  if (citationPrefix) {
    await dal.query(
      'DELETE FROM citation_claims WHERE citation_id IN (SELECT id FROM citations WHERE key LIKE $1)',
      [citationPrefix]
    );
    await dal.query('DELETE FROM citations WHERE key LIKE $1', [citationPrefix]);
  }
  if (claimPrefix) {
    await dal.query('DELETE FROM citation_claims WHERE claim_id LIKE $1', [claimPrefix]);
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

test('MCP rejects malformed unified patch hunks', async () => {
  const dal = await getDal();
  const slug = `test-mcp-patch-invalid-${Date.now()}`;
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
        title: { en: 'Patch Invalid Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
      },
      userId
    );

    const patch = ['--- before', '+++ after', '@@', '-Hello old world', '+Hello new world'].join(
      '\n'
    );

    await assert.rejects(
      () =>
        applyWikiPagePatch(
          dal,
          {
            slug,
            patch,
            format: 'unified',
            lang: 'en',
            revSummary: { en: 'Invalid patch update.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Invalid @@ hunk header'));
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

test('MCP rejects malformed codex patch hunks', async () => {
  const dal = await getDal();
  const slug = `test-mcp-codex-invalid-${Date.now()}`;
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
        title: { en: 'Patch Codex Invalid Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
      },
      userId
    );

    const patch = [
      '*** Begin Patch',
      `*** Update File: ${slug}`,
      '@@',
      '-Hello old world',
      '+Hello new world',
      '*** End Patch',
    ].join('\n');

    await assert.rejects(
      () =>
        applyWikiPagePatch(
          dal,
          {
            slug,
            patch,
            format: 'codex',
            lang: 'en',
            revSummary: { en: 'Invalid codex patch update.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Invalid @@ hunk header'));
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

test('MCP accepts codex patch targets with a leading slash', async () => {
  const dal = await getDal();
  const slug = `test-mcp-codex-slash-${Date.now()}`;
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
        title: { en: 'Patch Codex Slash Test' },
        body: { en: 'Hello old world' },
        originalLanguage: 'en',
      },
      userId
    );

    const patch = [
      '*** Begin Patch',
      `*** Update File: /${slug}`,
      '@@ -1 +1 @@',
      '-Hello old world',
      '+Hello new world',
      '*** End Patch',
    ].join('\n');

    const result = await applyWikiPagePatch(
      dal,
      {
        slug,
        patch,
        format: 'codex',
        lang: 'en',
        revSummary: { en: 'Codex patch with leading slash.' },
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

test('MCP rewrite section supports lead target', async () => {
  const dal = await getDal();
  const slug = `test-mcp-rewrite-lead-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    const originalBody = ['Lead paragraph.', '', '## History', 'Old line'].join('\n');

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Rewrite Lead Test' },
        body: { en: originalBody },
        originalLanguage: 'en',
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

test('MCP replace exact text applies multiple unique replacements atomically', async () => {
  const dal = await getDal();
  const slug = `test-mcp-replace-exact-${Date.now()}`;
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
        title: { en: 'Replace Exact Test' },
        body: { en: 'foo and bla' },
        originalLanguage: 'en',
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

test('MCP replace exact text rejects ambiguous replacements without partial edits', async () => {
  const dal = await getDal();
  const slug = `test-mcp-replace-exact-ambiguous-${Date.now()}`;
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
        title: { en: 'Replace Exact Ambiguous Test' },
        body: { en: 'foo and bla and bla' },
        originalLanguage: 'en',
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

    const { html } = await renderMarkdown(`Testing [@${citationKey}].`, [
      { ...(citation.data ?? {}), id: citation.key },
    ]);
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
      [
        { ...(citationA.data ?? {}), id: citationA.key },
        { ...(citationB.data ?? {}), id: citationB.key },
      ]
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

test('renderMarkdown links citation claims in bibliography', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-claim-${Date.now()}`;
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
          title: 'Citation with claim',
          URL: 'https://example.com/test-claim',
        },
      },
      userId
    );

    const { html } = await renderMarkdown(`Testing [@${citationKey}:birthdate].`, [
      { ...(citation.data ?? {}), id: citation.key },
    ]);

    assert.match(html, new RegExp(`/cite/${citationKey}#claim-birthdate`));
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

    const { html } = await renderMarkdown(`Testing [@${citationKey}].`, [
      { ...(citation.data ?? {}), id: citation.key },
    ]);
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

test('MCP rejects citation create when ISBN is an array', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-invalid-isbn-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    await assert.rejects(
      () =>
        createCitation(
          dal,
          {
            key: citationKey,
            data: {
              type: 'book',
              title: 'Invalid ISBN Citation',
              ISBN: ['9780444525123', '9780080931395'],
            },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'data.ISBN'));
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

test('MCP rejects citation update when CSL shape fails citeproc', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-invalid-author-${Date.now()}`;
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
          type: 'webpage',
          title: 'Valid Citation',
          URL: 'https://example.com/valid-citation',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        updateCitation(
          dal,
          {
            key: citationKey,
            data: {
              type: 'webpage',
              title: 'Invalid Author Shape',
              author: 'Alice Example',
              URL: 'https://example.com/invalid-author',
            },
            revSummary: { en: 'Introduce invalid author shape.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'data'));
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

test('MCP createCitation ignores submitted data.id and returns warning', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-ignore-id-create-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  let userIdForCleanup: string | null = null;

  try {
    const { user, token } = await createTestUser(dal);
    userIdForCleanup = user.id;

    process.env.AGPWIKI_MCP_TOKEN = token;
    const userId = await resolveAuthUserId();

    const created = await createCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: 'client-provided-id',
          type: 'webpage',
          title: 'Citation with ignored id',
          URL: 'https://example.com/citation-ignore-id-create',
        },
      },
      userId
    );

    assert.ok(
      created.warnings?.includes('Ignored data.id; citation key is authoritative.')
    );
    assert.equal(Object.hasOwn(created.data ?? {}, 'id'), false);

    const saved = await readCitation(dal, citationKey);
    assert.equal(Object.hasOwn(saved.data ?? {}, 'id'), false);
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

test('MCP updateCitation ignores submitted data.id and returns warning', async () => {
  const dal = await getDal();
  const citationKey = `test-cite-ignore-id-update-${Date.now()}`;
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
          type: 'webpage',
          title: 'Base citation',
          URL: 'https://example.com/citation-ignore-id-update',
        },
      },
      userId
    );

    const updated = await updateCitation(
      dal,
      {
        key: citationKey,
        data: {
          id: 'client-update-id',
          type: 'webpage',
          title: 'Updated citation',
          URL: 'https://example.com/citation-ignore-id-update-v2',
        },
        revSummary: { en: 'Update citation while submitting data.id.' },
      },
      userId
    );

    assert.ok(
      updated.warnings?.includes('Ignored data.id; citation key is authoritative.')
    );
    assert.equal(Object.hasOwn(updated.data ?? {}, 'id'), false);

    const saved = await readCitation(dal, citationKey);
    assert.equal(Object.hasOwn(saved.data ?? {}, 'id'), false);
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

test('MCP createCitationClaim requires quoteLanguage when quote provided', async () => {
  const dal = await getDal();
  const citationKey = `test-claim-quote-lang-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  const claimId = 'birthdate';
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
          type: 'webpage',
          title: 'Claim test citation',
          URL: 'https://example.com/claim-test',
        },
      },
      userId
    );

    await assert.rejects(
      () =>
        createCitationClaim(
          dal,
          {
            key: citationKey,
            claimId,
            assertion: { en: 'A test claim.' },
            quote: { en: 'A test quote.' },
          },
          userId
        ),
      error => {
        assert.ok(error instanceof ValidationError);
        assert.ok(error.fieldErrors?.some(entry => entry.field === 'quoteLanguage'));
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

test('MCP createCitationClaim and updateCitationClaim write revisions', async () => {
  const dal = await getDal();
  const citationKey = `test-claim-revisions-${Date.now()}`;
  const citationPrefix = `${citationKey}%`;
  const claimId = `claim-${Date.now()}`;
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
          type: 'webpage',
          title: 'Claim test citation',
          URL: 'https://example.com/claim-test-revisions',
        },
      },
      userId
    );

    const created = await createCitationClaim(
      dal,
      {
        key: citationKey,
        claimId,
        assertion: { en: 'Initial claim assertion.' },
        quote: { en: 'Initial quoted text.' },
        quoteLanguage: 'en',
        locatorType: 'page',
        locatorValue: { und: '42' },
      },
      userId
    );

    assert.equal(created.claimId, claimId);
    assert.equal(created.locatorValue?.und, '42');

    const updatedClaimId = `${claimId}-updated`;
    const updated = await updateCitationClaim(
      dal,
      {
        key: citationKey,
        claimId,
        newClaimId: updatedClaimId,
        assertion: { en: 'Updated claim assertion.' },
        revSummary: { en: 'Update claim assertion.' },
      },
      userId
    );

    assert.equal(updated.claimId, updatedClaimId);
    assert.equal(updated.assertion?.en, 'Updated claim assertion.');

    const readBack = await readCitationClaim(dal, citationKey, updatedClaimId);
    assert.equal(readBack.claimId, updatedClaimId);
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

test('MCP rejects unknown citation claim references', async () => {
  const dal = await getDal();
  const slug = `test-claim-ref-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  const citationKey = `test-claim-ref-cite-${Date.now()}`;
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
  } finally {
    try {
      await cleanupTestArtifacts(dal, {
        slugPrefix,
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
  assert.ok(mcpWithoutRole.adminTools.claimDeleteTool);

  assert.equal(mcpWithoutRole.adminTools.wikiDeletePageTool.enabled, false);
  assert.equal(mcpWithoutRole.adminTools.citationDeleteTool.enabled, false);
  assert.equal(mcpWithoutRole.adminTools.claimDeleteTool.enabled, false);
});

test('MCP admin tools are enabled with wiki_admin role', () => {
  const mcpWithRole = createMcpServer({ userRoles: [WIKI_ADMIN_ROLE] });
  assert.ok(mcpWithRole.adminTools.wikiDeletePageTool);
  assert.ok(mcpWithRole.adminTools.citationDeleteTool);
  assert.ok(mcpWithRole.adminTools.claimDeleteTool);

  assert.equal(mcpWithRole.adminTools.wikiDeletePageTool.enabled, true);
  assert.equal(mcpWithRole.adminTools.citationDeleteTool.enabled, true);
  assert.equal(mcpWithRole.adminTools.claimDeleteTool.enabled, true);
});
