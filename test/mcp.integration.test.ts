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
    const createdPayload = created.structuredContent as {
      body?: unknown;
      slug?: string;
      currentRevId?: string;
    };

    assert.equal(created.isError, undefined);
    assert.equal(createdPayload.slug, slug);
    assert.equal(Object.hasOwn(createdPayload, 'body'), false);
    assert.deepEqual(Object.keys(createdPayload).sort(), [
      'createdAt',
      'currentRevId',
      'id',
      'slug',
      'updatedAt',
    ]);
    assert.match(createdPayload.currentRevId ?? '', /^[0-9a-f-]{36}$/);

    const updated = await tools.blog_updatePost.handler(
      {
        slug,
        body: { en: 'Updated post body.' },
        revSummary: { en: 'Update blog body.' },
      },
      { authInfo }
    );
    const updatedPayload = updated.structuredContent as {
      body?: unknown;
      slug?: string;
      currentRevId?: string;
    };

    assert.equal(updated.isError, undefined);
    assert.equal(updatedPayload.slug, slug);
    assert.equal(Object.hasOwn(updatedPayload, 'body'), false);
    assert.notEqual(updatedPayload.currentRevId, createdPayload.currentRevId);

    const read = await tools.blog_readPost.handler({ slug });
    const readPayload = read.structuredContent as {
      body?: Record<string, string>;
      currentRevId?: string;
    };
    assert.equal(readPayload.body?.en, 'Updated post body.');
    assert.equal(readPayload.currentRevId, updatedPayload.currentRevId);
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

type ToolHandlers = ReturnType<typeof getToolHandlers>;
type ToolAuthInfo = { extra: { userId: string } };

const callTool = async <T>(
  tools: ToolHandlers,
  name: string,
  args: unknown,
  authInfo?: ToolAuthInfo
): Promise<T> => {
  const result = await tools[name].handler(args, authInfo ? { authInfo } : undefined);
  assert.equal(
    result.isError,
    undefined,
    `${name} failed: ${JSON.stringify(result.structuredContent)}`
  );
  return result.structuredContent as T;
};

type RevisionRead<T> = { revision: T & { revId: string } };

type WikiRevisionFields = {
  title: Record<string, string> | null;
  body: Record<string, string> | null;
};

const HISTORY_ORIGINAL_BODY_EN = 'Lead text.\n\n## History\n\nOld history.\n';
const HISTORY_BODY_DE = 'Einleitung.\n\n## Geschichte\n\nAlte Geschichte.\n';
const HISTORY_TITLE = { en: 'History Test', de: 'Verlaufstest' };

const wikiHistoryCases: Array<{
  tool: string;
  args: (slug: string, currentRevId: string) => Record<string, unknown>;
}> = [
  {
    tool: 'wiki_updatePage',
    args: (slug, currentRevId) => ({
      slug,
      body: { en: 'Lead text.\n\n## History\n\nNew history.\n' },
      expectedRevId: currentRevId,
    }),
  },
  {
    tool: 'wiki_applyPatch',
    args: (slug, currentRevId) => ({
      slug,
      format: 'unified',
      lang: 'en',
      patch: [
        '--- before',
        '+++ after',
        '@@ -3,3 +3,3 @@',
        ' ## History',
        ' ',
        '-Old history.',
        '+New history.',
      ].join('\n'),
      baseRevId: currentRevId,
    }),
  },
  {
    tool: 'wiki_rewriteSection',
    args: (slug, currentRevId) => ({
      slug,
      heading: 'History',
      content: 'New history.',
      lang: 'en',
      expectedRevId: currentRevId,
    }),
  },
  {
    tool: 'wiki_replaceExactText',
    args: (slug, currentRevId) => ({
      slug,
      replacements: [{ from: 'Old history.', to: 'New history.' }],
      lang: 'en',
      expectedRevId: currentRevId,
    }),
  },
];

for (const { tool, args } of wikiHistoryCases) {
  test(`MCP ${tool} leaves the previous wiki revision intact`, async () => {
    const dal = await getDal();
    const slug = `test-mcp-history-${tool.toLowerCase().replace('_', '-')}-${Date.now()}`;
    let userIdForCleanup: string | null = null;

    try {
      const user = await createTestUser();
      userIdForCleanup = user.id;
      await createWikiPage(
        dal,
        {
          slug,
          title: HISTORY_TITLE,
          body: { en: HISTORY_ORIGINAL_BODY_EN, de: HISTORY_BODY_DE },
          originalLanguage: 'en',
        },
        user.id
      );

      const { server } = createMcpServer({ skipPolicyCheck: true });
      const tools = getToolHandlers(server);
      const authInfo = { extra: { userId: user.id } };

      const before = await callTool<WikiRevisionFields & { currentRevId: string }>(
        tools,
        'wiki_readPage',
        { slug }
      );
      assert.equal(before.body?.en, HISTORY_ORIGINAL_BODY_EN);

      const written = await callTool<{ currentRevId: string }>(
        tools,
        tool,
        {
          ...args(slug, before.currentRevId),
          policyHash: '',
          revSummary: { en: `History check for ${tool}.` },
        },
        authInfo
      );
      assert.notEqual(written.currentRevId, before.currentRevId);

      const previous = await callTool<RevisionRead<WikiRevisionFields>>(
        tools,
        'wiki_readRevision',
        { slug, revId: before.currentRevId }
      );
      assert.equal(previous.revision.revId, before.currentRevId);
      assert.equal(previous.revision.body?.en, HISTORY_ORIGINAL_BODY_EN);
      assert.equal(previous.revision.body?.de, HISTORY_BODY_DE);
      assert.deepEqual(previous.revision.title, HISTORY_TITLE);

      const current = await callTool<WikiRevisionFields & { currentRevId: string }>(
        tools,
        'wiki_readPage',
        { slug }
      );
      assert.equal(current.currentRevId, written.currentRevId);
      assert.match(current.body?.en ?? '', /New history\./);
      assert.doesNotMatch(current.body?.en ?? '', /Old history\./);
      assert.equal(current.body?.de, HISTORY_BODY_DE);
      assert.deepEqual(current.title, HISTORY_TITLE);
    } finally {
      await cleanupTestArtifacts(dal, {
        slugPrefix: `${slug}%`,
        userId: userIdForCleanup ?? undefined,
      });
    }
  });
}

test('MCP blog_updatePost leaves the previous blog revision intact', async () => {
  const dal = await getDal();
  const slug = `test-mcp-history-blog-${Date.now()}`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    await grantRoleUpsert(dal, user.id, BLOG_AUTHOR_ROLE);

    const { server } = createMcpServer();
    const tools = getToolHandlers(server);
    const authInfo = { extra: { userId: user.id } };

    const title = { en: 'Blog History', de: 'Blog-Verlauf' };
    const summary = { en: 'Summary.', de: 'Zusammenfassung.' };
    const created = await callTool<{ currentRevId: string }>(
      tools,
      'blog_createPost',
      {
        slug,
        title,
        summary,
        body: { en: 'Old blog body.', de: 'Deutscher Text.' },
      },
      authInfo
    );

    const updated = await callTool<{ currentRevId: string }>(
      tools,
      'blog_updatePost',
      {
        slug,
        body: { en: 'New blog body.' },
        expectedRevId: created.currentRevId,
        revSummary: { en: 'Revise English body.' },
      },
      authInfo
    );
    assert.notEqual(updated.currentRevId, created.currentRevId);

    type BlogFields = {
      title: Record<string, string> | null;
      summary: Record<string, string> | null;
      body: Record<string, string> | null;
    };
    const previous = await callTool<RevisionRead<BlogFields>>(tools, 'blog_readRevision', {
      slug,
      revId: created.currentRevId,
    });
    assert.deepEqual(previous.revision.body, { en: 'Old blog body.', de: 'Deutscher Text.' });
    assert.deepEqual(previous.revision.title, title);
    assert.deepEqual(previous.revision.summary, summary);

    const current = await callTool<BlogFields & { currentRevId: string }>(
      tools,
      'blog_readPost',
      { slug }
    );
    assert.equal(current.currentRevId, updated.currentRevId);
    assert.deepEqual(current.body, { en: 'New blog body.', de: 'Deutscher Text.' });
    assert.deepEqual(current.title, title);
    assert.deepEqual(current.summary, summary);
  } finally {
    await cleanupTestArtifacts(dal, {
      postSlugPrefix: `${slug}%`,
      userId: userIdForCleanup ?? undefined,
    });
  }
});

test('MCP citation_update and claim_update leave previous revisions intact', async () => {
  const dal = await getDal();
  const key = `test-mcp-history-cite-${Date.now()}`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;

    const { server } = createMcpServer({ skipPolicyCheck: true });
    const tools = getToolHandlers(server);
    const authInfo = { extra: { userId: user.id } };

    const originalData = {
      type: 'book',
      title: 'Old citation title',
      author: [{ family: 'Doe', given: 'Jane' }],
      issued: { 'date-parts': [[2020]] },
    };
    const createdCitation = await callTool<{ currentRevId: string }>(
      tools,
      'citation_create',
      { key, data: originalData, policyHash: '' },
      authInfo
    );

    const updatedData = { ...originalData, title: 'New citation title' };
    const updatedCitation = await callTool<{ currentRevId: string }>(
      tools,
      'citation_update',
      {
        key,
        data: updatedData,
        expectedRevId: createdCitation.currentRevId,
        policyHash: '',
        revSummary: { en: 'Fix title.' },
      },
      authInfo
    );
    assert.notEqual(updatedCitation.currentRevId, createdCitation.currentRevId);

    type CitationFields = { data: Record<string, unknown> | null };
    const previousCitation = await callTool<RevisionRead<CitationFields>>(
      tools,
      'citation_readRevision',
      { key, revId: createdCitation.currentRevId }
    );
    assert.equal(previousCitation.revision.data?.title, 'Old citation title');
    assert.deepEqual(previousCitation.revision.data?.author, originalData.author);
    assert.deepEqual(previousCitation.revision.data?.issued, originalData.issued);

    const currentCitation = await callTool<CitationFields & { currentRevId: string }>(
      tools,
      'citation_read',
      { key }
    );
    assert.equal(currentCitation.currentRevId, updatedCitation.currentRevId);
    assert.equal(currentCitation.data?.title, 'New citation title');
    assert.deepEqual(currentCitation.data?.author, originalData.author);
    assert.deepEqual(currentCitation.data?.issued, originalData.issued);

    const claimId = 'history';
    const locatorValue = { en: '12' };
    const createdClaim = await callTool<{ currentRevId: string }>(
      tools,
      'claim_create',
      {
        key,
        claimId,
        assertion: { en: 'Old assertion.', de: 'Deutsche Aussage.' },
        locatorType: 'page',
        locatorValue,
        policyHash: '',
      },
      authInfo
    );

    const updatedClaim = await callTool<{ currentRevId: string }>(
      tools,
      'claim_update',
      {
        key,
        claimId,
        assertion: { en: 'New assertion.' },
        expectedRevId: createdClaim.currentRevId,
        policyHash: '',
        revSummary: { en: 'Refine assertion.' },
      },
      authInfo
    );
    assert.notEqual(updatedClaim.currentRevId, createdClaim.currentRevId);

    type ClaimFields = {
      assertion: Record<string, string> | null;
      locatorValue: Record<string, string> | null;
    };
    const previousClaim = await callTool<RevisionRead<ClaimFields>>(
      tools,
      'claim_readRevision',
      { key, claimId, revId: createdClaim.currentRevId }
    );
    assert.deepEqual(previousClaim.revision.assertion, {
      en: 'Old assertion.',
      de: 'Deutsche Aussage.',
    });
    assert.deepEqual(previousClaim.revision.locatorValue, locatorValue);

    const currentClaim = await callTool<ClaimFields & { currentRevId: string }>(
      tools,
      'claim_read',
      { key, claimId }
    );
    assert.equal(currentClaim.currentRevId, updatedClaim.currentRevId);
    assert.deepEqual(currentClaim.assertion, { en: 'New assertion.', de: 'Deutsche Aussage.' });
    assert.deepEqual(currentClaim.locatorValue, locatorValue);
  } finally {
    await dal.query(
      'DELETE FROM citation_claims WHERE citation_id IN (SELECT id FROM citations WHERE key LIKE $1)',
      [`${key}%`]
    );
    await dal.query('DELETE FROM citations WHERE key LIKE $1', [`${key}%`]);
    await cleanupTestArtifacts(dal, { userId: userIdForCleanup ?? undefined });
  }
});

test('MCP page_check_update leaves the previous page check revision intact', async () => {
  const dal = await getDal();
  const slug = `test-mcp-history-check-${Date.now()}`;
  let userIdForCleanup: string | null = null;

  try {
    const user = await createTestUser();
    userIdForCleanup = user.id;
    const page = await createWikiPage(
      dal,
      {
        slug,
        title: { en: 'Page Check History' },
        body: { en: 'Checked text.' },
        originalLanguage: 'en',
      },
      user.id
    );

    const { server } = createMcpServer({ skipPolicyCheck: true });
    const tools = getToolHandlers(server);
    const authInfo = { extra: { userId: user.id } };

    const originalMetrics = {
      issues_found: { high: 1, medium: 2, low: 0 },
      issues_fixed: { high: 0, medium: 1, low: 0 },
    };
    const notes = { en: 'Reviewer notes.' };
    const created = await callTool<{ id: string; currentRevId: string }>(
      tools,
      'page_check_create',
      {
        slug,
        type: 'fact_check',
        status: 'in_progress',
        checkResults: { en: 'Old results.', de: 'Alte Ergebnisse.' },
        notes,
        metrics: originalMetrics,
        targetRevId: page.currentRevId,
        policyHash: '',
      },
      authInfo
    );

    const updatedMetrics = {
      issues_found: { high: 1, medium: 2, low: 0 },
      issues_fixed: { high: 1, medium: 2, low: 0 },
    };
    const updated = await callTool<{ currentRevId: string }>(
      tools,
      'page_check_update',
      {
        checkId: created.id,
        status: 'completed',
        checkResults: { en: 'New results.' },
        metrics: updatedMetrics,
        expectedRevId: created.currentRevId,
        policyHash: '',
        revSummary: { en: 'Record fixes.' },
      },
      authInfo
    );
    assert.notEqual(updated.currentRevId, created.currentRevId);

    type CheckFields = {
      status: string;
      checkResults: Record<string, string> | null;
      notes: Record<string, string> | null;
      metrics: typeof originalMetrics | null;
      targetRevId: string;
    };
    const previous = await callTool<RevisionRead<CheckFields>>(
      tools,
      'page_check_readRevision',
      { checkId: created.id, revId: created.currentRevId }
    );
    assert.equal(previous.revision.status, 'in_progress');
    assert.deepEqual(previous.revision.checkResults, {
      en: 'Old results.',
      de: 'Alte Ergebnisse.',
    });
    assert.deepEqual(previous.revision.metrics, originalMetrics);
    assert.deepEqual(previous.revision.notes, notes);
    assert.equal(previous.revision.targetRevId, page.currentRevId);

    type ListedCheck = CheckFields & { id: string; currentRevId: string };
    const listed = await callTool<{ checks: ListedCheck[] }>(tools, 'page_check_list', { slug });
    const current = listed.checks.find(check => check.id === created.id);
    assert.ok(current);
    assert.equal(current.currentRevId, updated.currentRevId);
    assert.equal(current.status, 'completed');
    assert.deepEqual(current.checkResults, { en: 'New results.', de: 'Alte Ergebnisse.' });
    assert.deepEqual(current.metrics, updatedMetrics);
    assert.deepEqual(current.notes, notes);
    assert.equal(current.targetRevId, page.currentRevId);
  } finally {
    await dal.query(
      'DELETE FROM page_checks WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE $1)',
      [`${slug}%`]
    );
    await cleanupTestArtifacts(dal, {
      slugPrefix: `${slug}%`,
      userId: userIdForCleanup ?? undefined,
    });
  }
});
