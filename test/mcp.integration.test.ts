import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { createMcpServer } from '../src/mcp/core.js';
import { initializePostgreSQL } from '../src/db.js';
import {
  BLOG_ADMIN_ROLE,
  BLOG_AUTHOR_ROLE,
  WIKI_ADMIN_ROLE,
  grantRoleUpsert,
} from '../src/services/roles.js';
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
    username: `mcptest${Date.now()}`,
    displayName: 'MCP Test',
    email,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
  });
};

const cleanupTestArtifacts = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  {
    slugPrefix,
    postSlugPrefix,
    userId,
  }: { slugPrefix?: string; postSlugPrefix?: string; userId?: string }
) => {
  if (slugPrefix) {
    await dal.query(
      'DELETE FROM admin_events WHERE target_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
      [slugPrefix]
    );
    await dal.query(
      'DELETE FROM page_protections WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
      [slugPrefix]
    );
    await dal.query('DELETE FROM pages WHERE slug LIKE $1', [slugPrefix]);
  }
  if (postSlugPrefix) {
    await dal.query('DELETE FROM posts WHERE slug LIKE $1', [postSlugPrefix]);
  }
  if (userId) {
    await dal.query('DELETE FROM admin_events WHERE actor_user_id = $1', [userId]);
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
  assert.ok(mcpWithoutRoles.adminTools.wikiProtectPageTool);
  assert.ok(mcpWithoutRoles.adminTools.wikiUnprotectPageTool);
  assert.ok(mcpWithoutRoles.adminTools.citationDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.claimDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.mediaDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.pageCheckDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.blogDeleteTool);

  assert.equal(mcpWithoutRoles.adminTools.wikiDeletePageTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.wikiProtectPageTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.wikiUnprotectPageTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.citationDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.claimDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.mediaDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.pageCheckDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.blogDeleteTool.enabled, false);
});

test('MCP wiki admin tools are enabled with wiki_admin role', () => {
  const mcpWithWikiAdmin = createMcpServer({ userRoles: [WIKI_ADMIN_ROLE] });

  assert.equal(mcpWithWikiAdmin.adminTools.wikiDeletePageTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.wikiProtectPageTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.wikiUnprotectPageTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.citationDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.claimDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.mediaDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.pageCheckDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.blogDeleteTool.enabled, false);
});

test('MCP blog admin tool is enabled with blog_admin role', () => {
  const mcpWithBlogAdmin = createMcpServer({ userRoles: [BLOG_ADMIN_ROLE] });

  assert.equal(mcpWithBlogAdmin.adminTools.blogDeleteTool.enabled, true);
  assert.equal(mcpWithBlogAdmin.adminTools.wikiDeletePageTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.wikiProtectPageTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.wikiUnprotectPageTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.citationDeleteTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.claimDeleteTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.mediaDeleteTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.pageCheckDeleteTool.enabled, false);
});

test('MCP wiki_readPage returns content hash and current revision id', async () => {
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
    const payload = result.structuredContent as {
      contentHash?: string;
      currentRevId?: string;
      slug?: string;
    };

    assert.equal(result.isError, undefined);
    assert.equal(payload.slug, slug);
    assert.equal(typeof payload.contentHash, 'string');
    assert.equal(payload.contentHash?.length, 64);
    assert.match(payload.currentRevId ?? '', /^[0-9a-f-]{36}$/);
  } finally {
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('MCP wiki protection tools update read editability hints', async () => {
  const dal = await getDal();
  const slug = `test-mcp-protect-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let adminId: string | null = null;
  let editorId: string | null = null;

  try {
    const admin = await createTestUser();
    const editor = await createTestUser();
    adminId = admin.id;
    editorId = editor.id;
    await grantRoleUpsert(dal, admin.id, WIKI_ADMIN_ROLE);
    await dal.query('DELETE FROM pages WHERE slug = $1', ['meta/policy']);

    await createWikiPage(
      dal,
      {
        slug: 'meta/policy',
        title: { en: 'Policy' },
        body: { en: 'Current policy text.' },
        originalLanguage: 'en',
      },
      admin.id
    );
    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Protect Test' },
        body: { en: 'Editable content.' },
        originalLanguage: 'en',
      },
      editor.id
    );

    const { server } = createMcpServer({ userRoles: [WIKI_ADMIN_ROLE] });
    const tools = getToolHandlers(server);
    const policyRead = await tools.wiki_readPage.handler({ slug: 'meta/policy' });
    const policyHash = (policyRead.structuredContent as { contentHash: string }).contentHash;

    const protectedResult = await tools.wiki_protectPage.handler(
      {
        slug,
        reason: 'Prompt injection mitigation.',
        policyHash,
      },
      { authInfo: { extra: { userId: admin.id } } }
    );
    assert.equal(protectedResult.isError, undefined);

    const editorRead = await tools.wiki_readPage.handler(
      { slug },
      { authInfo: { extra: { userId: editor.id } } }
    );
    const editorPayload = editorRead.structuredContent as {
      isProtected?: boolean;
      isEditable?: boolean;
    };
    assert.equal(editorPayload.isProtected, true);
    assert.equal(editorPayload.isEditable, false);

    const adminRead = await tools.wiki_readPage.handler(
      { slug },
      { authInfo: { extra: { userId: admin.id } } }
    );
    const adminPayload = adminRead.structuredContent as {
      isProtected?: boolean;
      isEditable?: boolean;
    };
    assert.equal(adminPayload.isProtected, true);
    assert.equal(adminPayload.isEditable, true);
  } finally {
    await dal.query('DELETE FROM admin_events WHERE target_id IN (SELECT id FROM pages WHERE slug = $1)', [
      'meta/policy',
    ]);
    await dal.query('DELETE FROM page_protections WHERE page_id IN (SELECT id FROM pages WHERE slug = $1)', [
      'meta/policy',
    ]);
    await dal.query('DELETE FROM pages WHERE slug = $1', ['meta/policy']);
    await cleanupTestArtifacts(dal, {
      slugPrefix,
      userId: editorId ?? undefined,
    });
    await cleanupTestArtifacts(dal, {
      userId: adminId ?? undefined,
    });
  }
});

test('MCP currentRevId from wiki_readPage works as expectedRevId', async () => {
  const dal = await getDal();
  const slug = `test-mcp-expected-rev-${Date.now()}`;
  const user = await createTestUser();
  let userIdForCleanup: string | null = user.id;

  try {
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

    await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Expected Rev Test' },
        body: { en: 'Hello world' },
        originalLanguage: 'en',
      },
      user.id
    );

    const { server } = createMcpServer();
    const tools = getToolHandlers(server);
    const authInfo = { extra: { userId: user.id } };
    const policyRead = await tools.wiki_readPage.handler({ slug: 'meta/policy' });
    const pageRead = await tools.wiki_readPage.handler({ slug });
    const policyHash = (policyRead.structuredContent as { contentHash: string }).contentHash;
    const currentRevId = (pageRead.structuredContent as { currentRevId: string }).currentRevId;

    const result = await tools.wiki_replaceExactText.handler(
      {
        slug,
        replacements: [{ from: 'Hello world', to: 'Hello revised world' }],
        expectedRevId: currentRevId,
        policyHash,
        revSummary: { en: 'Use currentRevId from readPage.' },
      },
      { authInfo }
    );
    const payload = result.structuredContent as {
      body?: unknown;
      contentHash?: string;
      currentRevId?: string;
    };

    assert.equal(result.isError, undefined);
    assert.equal(Object.hasOwn(payload, 'body'), false);
    assert.equal(typeof payload.contentHash, 'string');
    assert.equal(payload.contentHash?.length, 64);
    assert.notEqual(payload.currentRevId, currentRevId);

    const updatedRead = await tools.wiki_readPage.handler({ slug });
    const updatedPayload = updatedRead.structuredContent as { body?: Record<string, string> };
    assert.equal(updatedPayload.body?.en, 'Hello revised world');
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
      'Use wiki_readPage to read /meta/policy and linked pages that are marked required reading, then submit the contentHash for /meta/policy.'
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
    const acceptedPayload = accepted.structuredContent as {
      body?: unknown;
      contentHash?: string;
      currentRevId?: string;
      slug?: string;
    };

    assert.equal(accepted.isError, undefined);
    assert.equal(acceptedPayload.slug, slug);
    assert.equal(Object.hasOwn(acceptedPayload, 'body'), false);
    assert.equal(typeof acceptedPayload.contentHash, 'string');
    assert.equal(acceptedPayload.contentHash?.length, 64);
    assert.match(acceptedPayload.currentRevId ?? '', /^[0-9a-f-]{36}$/);
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

test('MCP policy hash gate can be explicitly skipped for bootstrap', async () => {
  const dal = await getDal();
  const slug = `test-mcp-policy-skip-${Date.now()}`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    await dal.query('DELETE FROM pages WHERE slug = $1', ['meta/policy']);

    const { server } = createMcpServer({ skipPolicyCheck: true });
    const tools = getToolHandlers(server);
    const authInfo = { extra: { userId: user.id } };

    const accepted = await tools.wiki_createPage.handler(
      {
        slug,
        title: { en: 'Policy Skip Test' },
        body: { en: 'Allowed during bootstrap.' },
        policyHash: '',
      },
      { authInfo }
    );
    const acceptedPayload = accepted.structuredContent as {
      body?: unknown;
      contentHash?: string;
      currentRevId?: string;
      slug?: string;
    };

    assert.equal(accepted.isError, undefined);
    assert.equal(acceptedPayload.slug, slug);
    assert.equal(Object.hasOwn(acceptedPayload, 'body'), false);
    assert.equal(typeof acceptedPayload.contentHash, 'string');
    assert.equal(acceptedPayload.contentHash?.length, 64);
    assert.match(acceptedPayload.currentRevId ?? '', /^[0-9a-f-]{36}$/);
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

test('MCP blog write tools omit full body from responses', async () => {
  const dal = await getDal();
  const slug = `test-mcp-blog-write-${Date.now()}`;
  const slugPrefix = `${slug}%`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    await grantRoleUpsert(dal, user.id, BLOG_AUTHOR_ROLE);

    const { server } = createMcpServer();
    const tools = getToolHandlers(server);
    const authInfo = { extra: { userId: user.id } };

    const created = await tools.blog_createPost.handler(
      {
        slug,
        title: { en: 'Blog Write Test' },
        body: { en: 'Initial post body.' },
        summary: { en: 'Initial summary.' },
      },
      { authInfo }
    );
    const createdPayload = created.structuredContent as { body?: unknown; slug?: string };

    assert.equal(created.isError, undefined);
    assert.equal(createdPayload.slug, slug);
    assert.equal(Object.hasOwn(createdPayload, 'body'), false);

    const updated = await tools.blog_updatePost.handler(
      {
        slug,
        body: { en: 'Updated post body.' },
        revSummary: { en: 'Update blog body.' },
      },
      { authInfo }
    );
    const updatedPayload = updated.structuredContent as { body?: unknown; slug?: string };

    assert.equal(updated.isError, undefined);
    assert.equal(updatedPayload.slug, slug);
    assert.equal(Object.hasOwn(updatedPayload, 'body'), false);

    const read = await tools.blog_readPost.handler({ slug });
    const readPayload = read.structuredContent as { body?: Record<string, string> };
    assert.equal(readPayload.body?.en, 'Updated post body.');
  } finally {
    await cleanupTestArtifacts(dal, {
      postSlugPrefix: slugPrefix,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('MCP citation_create rejects a stale or wrong policy hash', async () => {
  const dal = await getDal();
  const citationKey = `test-mcp-policy-cite-${Date.now()}`;
  const user = await createTestUser();
  let userIdForCleanup: string | null = user.id;

  try {
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

    const rejected = await tools.citation_create.handler(
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Blocked with wrong policy hash',
          URL: 'https://example.com/policy-test',
        },
        policyHash: 'wrong-hash',
      },
      { authInfo }
    );
    const rejectedPayload = rejected.structuredContent as {
      error: {
        code: string;
        message?: string;
      };
    };

    assert.equal(rejected.isError, true);
    assert.equal(rejectedPayload.error.code, 'precondition_failed');
    assert.equal(
      rejectedPayload.error.message,
      'Use wiki_readPage to read /meta/policy and linked pages that are marked required reading, then submit the contentHash for /meta/policy.'
    );

    const policyRead = await tools.wiki_readPage.handler({ slug: 'meta/policy' });
    const policyHash = (policyRead.structuredContent as { contentHash: string }).contentHash;

    const accepted = await tools.citation_create.handler(
      {
        key: citationKey,
        data: {
          type: 'webpage',
          title: 'Allowed with policy hash',
          URL: 'https://example.com/policy-test',
        },
        policyHash,
      },
      { authInfo }
    );
    const acceptedPayload = accepted.structuredContent as { key?: string };

    assert.equal(accepted.isError, undefined);
    assert.equal(acceptedPayload.key, citationKey);
  } finally {
    await dal.query('DELETE FROM citations WHERE key LIKE $1', [`${citationKey}%`]);
    await dal.query('DELETE FROM pages WHERE slug = $1', ['meta/policy']);
    await cleanupTestArtifacts(dal, {
      userId: userIdForCleanup ?? undefined,
    });
  }
});
