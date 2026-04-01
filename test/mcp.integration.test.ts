import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { createMcpServer } from '../src/mcp/core.js';
import { initializePostgreSQL } from '../src/db.js';
import { BLOG_ADMIN_ROLE, WIKI_ADMIN_ROLE } from '../src/services/roles.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';
import User from '../src/models/user.js';

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

const createTestUser = async () => {
  const email = `mcp-test-${Date.now()}@example.com`;
  return User.create({
    displayName: 'MCP Test',
    email,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

const cleanupTestArtifacts = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  { slugPrefix, userId }: { slugPrefix?: string; userId?: string }
) => {
  if (slugPrefix) {
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [slugPrefix]);
  }
  if (userId) {
    await dal.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

type RegisteredToolHandler = (args: unknown, extra?: { authInfo?: { extra?: { userId?: string } } }) => Promise<{
  isError?: boolean;
  structuredContent: unknown;
}>;

const getToolHandlers = (server: object) =>
  (server as { _registeredTools: Record<string, { handler: RegisteredToolHandler }> })._registeredTools;

test('MCP admin tools are disabled without admin roles', () => {
  const mcpWithoutRoles = createMcpServer({ userRoles: [] });

  assert.ok(mcpWithoutRoles.adminTools.wikiDeletePageTool);
  assert.ok(mcpWithoutRoles.adminTools.citationDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.claimDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.pageCheckDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.blogDeleteTool);

  assert.equal(mcpWithoutRoles.adminTools.wikiDeletePageTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.citationDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.claimDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.pageCheckDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.blogDeleteTool.enabled, false);
});

test('MCP wiki admin tools are enabled with wiki_admin role', () => {
  const mcpWithWikiAdmin = createMcpServer({ userRoles: [WIKI_ADMIN_ROLE] });

  assert.equal(mcpWithWikiAdmin.adminTools.wikiDeletePageTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.citationDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.claimDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.pageCheckDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.blogDeleteTool.enabled, false);
});

test('MCP blog admin tool is enabled with blog_admin role', () => {
  const mcpWithBlogAdmin = createMcpServer({ userRoles: [BLOG_ADMIN_ROLE] });

  assert.equal(mcpWithBlogAdmin.adminTools.blogDeleteTool.enabled, true);
  assert.equal(mcpWithBlogAdmin.adminTools.wikiDeletePageTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.citationDeleteTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.claimDeleteTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.pageCheckDeleteTool.enabled, false);
});

test('MCP wiki_readPage returns a content hash', async () => {
  const dal = await getDal();
  const slug = `test-mcp-read-hash-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Read Hash Test' },
        body: { en: 'Hashable content.' },
        originalLanguage: 'en',
      },
      user.id
    );

    const { server } = createMcpServer();
    const tools = getToolHandlers(server);
    const result = await tools.wiki_readPage.handler({ slug });
    const payload = result.structuredContent as { contentHash?: string; slug?: string };

    assert.equal(result.isError, undefined);
    assert.equal(payload.slug, slug);
    assert.equal(typeof payload.contentHash, 'string');
    assert.equal(payload.contentHash?.length, 64);
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('MCP wiki write tools require the latest policy hash', async () => {
  const dal = await getDal();
  const slug = `test-mcp-policy-gate-${Date.now()}`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    await dal.query('DELETE FROM pages WHERE slug = $1', ['meta/policy']);

    await createWikiPage(
      dal,
      {
        slug: 'meta/policy',
        title: { en: 'Policy' },
        body: { en: 'Current policy text.' },
        originalLanguage: 'en',
      },
      user.id
    );

    const { server } = createMcpServer();
    const tools = getToolHandlers(server);
    const authInfo = { extra: { userId: user.id } };

    const rejected = await tools.wiki_createPage.handler(
      {
        slug,
        title: { en: 'Policy Gate Test' },
        body: { en: 'Blocked without policy hash.' },
      },
      { authInfo }
    );
    const rejectedPayload = rejected.structuredContent as {
      error: {
        code: string;
        message: string;
        details: Record<string, string>;
      };
    };

    assert.equal(rejected.isError, true);
    assert.equal(rejectedPayload.error.code, 'precondition_failed');
    assert.equal(
      rejectedPayload.error.message,
      'Read /meta/policy and linked pages with wiki_readPage. Submit the contentHash of /meta/policy as policyHash.'
    );
    assert.deepEqual(rejectedPayload.error.details, {
      requiredPageSlug: 'meta/policy',
      requiredParam: 'policyHash',
    });

    const policyRead = await tools.wiki_readPage.handler({ slug: 'meta/policy' });
    const policyHash = (policyRead.structuredContent as { contentHash: string }).contentHash;

    const accepted = await tools.wiki_createPage.handler(
      {
        slug,
        title: { en: 'Policy Gate Test' },
        body: { en: 'Allowed with policy hash.' },
        policyHash,
      },
      { authInfo }
    );
    const acceptedPayload = accepted.structuredContent as { slug?: string };

    assert.equal(accepted.isError, undefined);
    assert.equal(acceptedPayload.slug, slug);
  } finally {
    const pagePrefixes = ['meta/policy', slug];
    for (const pagePrefix of pagePrefixes) {
      await dal.query('DELETE FROM pages WHERE slug LIKE $1', [`${pagePrefix}%`]);
    }
    await cleanupTestArtifacts(dal, {
      userId: userIdForCleanup ?? undefined,
    });
  }
});
