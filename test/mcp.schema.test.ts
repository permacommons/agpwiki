import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpServer } from '../src/mcp/core.js';
import { toValidationErrorFromZod } from '../src/mcp/errors.js';

const getSchemaShape = (schema: unknown): Record<string, { description?: string }> => {
  if (!schema || typeof schema !== 'object') return {};
  const asAny = schema as { _zod?: { def?: { shape?: unknown } }; shape?: unknown };
  const rawShape = asAny._zod?.def?.shape ?? asAny.shape;
  if (typeof rawShape === 'function') {
    try {
      return rawShape() as Record<string, { description?: string }>;
    } catch {
      return {};
    }
  }
  return (rawShape ?? {}) as Record<string, { description?: string }>;
};

test('MCP tool schemas describe localized fields', () => {
  const { server } = createMcpServer();
  const tools = (server as { _registeredTools: Record<string, { inputSchema: unknown }> })
    ._registeredTools;

  const wikiCreate = getSchemaShape(tools.wiki_createPage.inputSchema);
  assert.ok(wikiCreate.title?.description?.includes('agpwiki://locales'));
  assert.ok(wikiCreate.body?.description?.includes('agpwiki://locales'));
  assert.ok(wikiCreate.body?.description?.includes('Each value is Markdown.'));
  assert.ok(wikiCreate.revSummary?.description?.includes('agpwiki://locales'));

  const blogCreate = getSchemaShape(tools.blog_createPost.inputSchema);
  assert.ok(blogCreate.body?.description?.includes('Each value is Markdown.'));
  assert.ok(blogCreate.summary?.description?.includes('agpwiki://locales'));
  assert.ok(blogCreate.originalLanguage?.description?.includes('agpwiki://locales'));

  const blogUpdate = getSchemaShape(tools.blog_updatePost.inputSchema);
  assert.ok(blogUpdate.body?.description?.includes('Each value is Markdown.'));

  const wikiApply = getSchemaShape(tools.wiki_applyPatch.inputSchema);
  assert.ok(wikiApply.lang?.description?.includes('agpwiki://locales'));
  assert.ok(wikiApply.policyHash);

  const wikiRewrite = getSchemaShape(tools.wiki_rewriteSection.inputSchema);
  assert.ok(wikiRewrite.lang?.description?.includes('agpwiki://locales'));
  assert.ok(wikiRewrite.policyHash);

  const wikiReplaceExact = getSchemaShape(tools.wiki_replaceExactText.inputSchema);
  assert.ok(wikiReplaceExact.lang?.description?.includes('agpwiki://locales'));
  assert.ok(wikiReplaceExact.policyHash);

  assert.ok(wikiCreate.policyHash);

  const wikiUpdate = getSchemaShape(tools.wiki_updatePage.inputSchema);
  assert.ok(wikiUpdate.policyHash);
  assert.ok(wikiUpdate.body?.description?.includes('Each value is Markdown.'));

  const wikiAddAlias = getSchemaShape(tools.wiki_addAlias.inputSchema);
  assert.ok(wikiAddAlias.policyHash);

  const wikiRemoveAlias = getSchemaShape(tools.wiki_removeAlias.inputSchema);
  assert.ok(wikiRemoveAlias.policyHash);

  const blogDelete = getSchemaShape(tools.blog_deletePost.inputSchema);
  assert.ok(blogDelete.revSummary?.description?.includes('agpwiki://locales'));

  const citationCreate = getSchemaShape(tools.citation_create.inputSchema);
  assert.ok(citationCreate.policyHash);

  const citationUpdate = getSchemaShape(tools.citation_update.inputSchema);
  assert.ok(citationUpdate.policyHash);

  const claimCreate = getSchemaShape(tools.claim_create.inputSchema);
  assert.ok(claimCreate.policyHash);
  assert.ok(claimCreate.assertion?.description?.includes('plain-text assertion'));
  assert.ok(claimCreate.assertion?.description?.includes('not Markdown'));
  assert.ok(claimCreate.quote?.description?.includes('plain-text quote'));
  assert.ok(claimCreate.quote?.description?.includes('not Markdown'));

  const claimUpdate = getSchemaShape(tools.claim_update.inputSchema);
  assert.ok(claimUpdate.policyHash);

  const pageCheckCreate = getSchemaShape(tools.page_check_create.inputSchema);
  assert.ok(pageCheckCreate.policyHash);

  const pageCheckUpdate = getSchemaShape(tools.page_check_update.inputSchema);
  assert.ok(pageCheckUpdate.policyHash);

  const wikiDelete = getSchemaShape(tools.wiki_deletePage.inputSchema);
  assert.ok(wikiDelete.policyHash);

  const citationDelete = getSchemaShape(tools.citation_delete.inputSchema);
  assert.ok(citationDelete.policyHash);

  const claimDelete = getSchemaShape(tools.claim_delete.inputSchema);
  assert.ok(claimDelete.policyHash);

  const pageCheckDelete = getSchemaShape(tools.page_check_delete.inputSchema);
  assert.ok(pageCheckDelete.policyHash);
});

test('MCP tool schema hints describe character caps', () => {
  const { server } = createMcpServer();
  const tools = (server as { _registeredTools: Record<string, { inputSchema: unknown }> })
    ._registeredTools;

  const wikiCreate = getSchemaShape(tools.wiki_createPage.inputSchema);
  assert.ok(wikiCreate.slug?.description?.includes('Max 200 characters'));
  assert.ok(wikiCreate.title?.description?.includes('Max 200 characters per language'));
  assert.ok(wikiCreate.body?.description?.includes('Max 20000 characters per language'));
  assert.ok(wikiCreate.originalLanguage?.description?.includes('Max 8 characters'));
  assert.ok(wikiCreate.revSummary?.description?.includes('Max 300 characters per language'));

  const blogCreate = getSchemaShape(tools.blog_createPost.inputSchema);
  assert.ok(blogCreate.summary?.description?.includes('Max 500 characters per language'));

  const citationUpdate = getSchemaShape(tools.citation_update.inputSchema);
  assert.ok(citationUpdate.key?.description?.includes('Max 200 characters'));
  assert.ok(citationUpdate.newKey?.description?.includes('Max 200 characters'));

  const claimCreate = getSchemaShape(tools.claim_create.inputSchema);
  assert.ok(claimCreate.claimId?.description?.includes('Max 200 characters'));
  assert.ok(claimCreate.assertion?.description?.includes('Max 2000 characters per language'));
  assert.ok(claimCreate.quote?.description?.includes('Max 4000 characters per language'));
  assert.ok(claimCreate.locatorType?.description?.includes('Max 32 characters'));
  assert.ok(claimCreate.locatorValue?.description?.includes('Max 200 characters per language'));
  assert.ok(claimCreate.locatorLabel?.description?.includes('Max 200 characters per language'));

  const pageCheckCreate = getSchemaShape(tools.page_check_create.inputSchema);
  assert.ok(pageCheckCreate.type?.description?.includes('Max 64 characters'));
  assert.ok(pageCheckCreate.status?.description?.includes('Max 32 characters'));
  assert.ok(
    pageCheckCreate.checkResults?.description?.includes('Max 2000 characters per language')
  );
  assert.ok(pageCheckCreate.notes?.description?.includes('Max 10000 characters per language'));
});

test('MCP localized field validation errors mention language maps', () => {
  const { server } = createMcpServer();
  const tools = (server as { _registeredTools: Record<string, { inputSchema: unknown }> })
    ._registeredTools;

  const wikiCreateSchema = tools.wiki_createPage.inputSchema as {
    safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
  };
  const invalidTitle = wikiCreateSchema.safeParse({ slug: 'test', title: 'bad' });
  assert.equal(invalidTitle.success, false);
  assert.ok(
    invalidTitle.error?.issues.some(issue => issue.message.includes('agpwiki://locales'))
  );

  const wikiDiffSchema = tools.wiki_diffRevisions.inputSchema as {
    safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
  };
  const invalidLang = wikiDiffSchema.safeParse({ slug: 'test', fromRevId: 'rev', lang: 123 });
  assert.equal(invalidLang.success, false);
  assert.ok(invalidLang.error?.issues.some(issue => issue.message.includes('agpwiki://locales')));
});

test('MCP localized maps accept null language values', () => {
  const { server } = createMcpServer();
  const tools = (server as { _registeredTools: Record<string, { inputSchema: unknown }> })
    ._registeredTools;

  const wikiUpdateSchema = tools.wiki_updatePage.inputSchema as {
    safeParse: (value: unknown) => { success: boolean };
  };
  const result = wikiUpdateSchema.safeParse({
    slug: 'test',
    policyHash: 'hash',
    revSummary: { en: 'update' },
    title: { de: null },
  });
  assert.equal(result.success, true);
});

test('MCP schema errors use required field messages', () => {
  const { server } = createMcpServer();
  const tools = (server as { _registeredTools: Record<string, { inputSchema: unknown }> })
    ._registeredTools;

  const wikiUpdateSchema = tools.wiki_updatePage.inputSchema as {
    safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
  };
  const missingRevSummary = wikiUpdateSchema.safeParse({ slug: 'test' });
  assert.equal(missingRevSummary.success, false);
  assert.ok(missingRevSummary.error?.issues.some(issue => issue.message === 'revSummary is required.'));

  const missingPolicyHash = wikiUpdateSchema.safeParse({
    slug: 'test',
    revSummary: { en: 'update' },
  });
  assert.equal(missingPolicyHash.success, false);
  assert.ok(missingPolicyHash.error?.issues.some(issue => issue.message === 'policyHash is required.'));
});

test('MCP schema validates revision IDs as UUIDs', () => {
  const { server } = createMcpServer();
  const tools = (server as { _registeredTools: Record<string, { inputSchema: unknown }> })
    ._registeredTools;

  const wikiReadRevisionSchema = tools.wiki_readRevision.inputSchema as {
    safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
  };
  const invalidRevId = wikiReadRevisionSchema.safeParse({
    slug: 'test',
    revId: 'not-a-uuid',
  });
  assert.equal(invalidRevId.success, false);
  assert.ok(
    invalidRevId.error?.issues.some(issue => issue.message.includes('valid UUID'))
  );
});

test('MCP page check type validation lists allowed values', () => {
  const { server } = createMcpServer();
  const tools = (server as { _registeredTools: Record<string, { inputSchema: unknown }> })
    ._registeredTools;

  const pageCheckCreateSchema = tools.page_check_create.inputSchema as {
    safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } };
  };
  const invalidType = pageCheckCreateSchema.safeParse({
    slug: 'test',
    type: 'manual',
    status: 'completed',
    checkResults: { en: 'ok' },
    metrics: {
      issues_found: { high: 0, medium: 0, low: 0 },
      issues_fixed: { high: 0, medium: 0, low: 0 },
    },
    targetRevId: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal(invalidType.success, false);
  assert.ok(invalidType.error?.issues.some(issue => issue.message.includes('Must be one of:')));
  assert.ok(invalidType.error?.issues.some(issue => issue.message.includes('fact_check')));
});

test('MCP rewrite section content hint explains heading behavior', () => {
  const { server } = createMcpServer();
  const tools = (server as { _registeredTools: Record<string, { inputSchema: unknown }> })
    ._registeredTools;

  const wikiRewrite = getSchemaShape(tools.wiki_rewriteSection.inputSchema);
  assert.ok(wikiRewrite.content?.description?.includes('body text only'));
  assert.ok(wikiRewrite.content?.description?.includes('heading line is preserved'));
});

test('Zod issues map to validation errors', () => {
  const issues = [
    { code: 'invalid_type', path: ['slug'], message: 'slug is required.', input: undefined },
    { code: 'invalid_type', path: ['revSummary'], message: 'revSummary is required.', input: undefined },
    { code: 'custom', path: ['body'], message: 'Expected body to be a language-keyed map.' },
  ];
  const error = toValidationErrorFromZod('Invalid arguments for tool test.', issues);
  assert.equal(error.code, 'validation_error');
  assert.ok(error.fieldErrors?.some(entry => entry.field === 'slug' && entry.code === 'required'));
  assert.ok(
    error.fieldErrors?.some(entry => entry.field === 'revSummary' && entry.code === 'required')
  );
  assert.ok(error.fieldErrors?.some(entry => entry.field === 'body' && entry.code === 'invalid'));
});

test('MCP locales resource returns supported locales', async () => {
  const { server } = createMcpServer();
  const resources = (server as {
    _registeredResources: Record<
      string,
      {
        readCallback: (uri: URL) => Promise<{ contents: { text?: string }[] }>;
      }
    >;
  })._registeredResources;

  const localesResource = resources['agpwiki://locales'];
  assert.ok(localesResource);

  const result = await localesResource.readCallback(new URL('agpwiki://locales?uiLocale=en'));
  const payload = JSON.parse(result.contents[0]?.text ?? '{}') as {
    uiLocale?: string;
    supportedLocales?: string[];
  };

  assert.equal(payload.uiLocale, 'en');
  assert.ok(Array.isArray(payload.supportedLocales));
  assert.ok(payload.supportedLocales?.includes('en'));
});
