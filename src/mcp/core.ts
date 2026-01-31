import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  McpError,
  ReadResourceRequestSchema,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getLanguageOptions } from '../../locales/cldr.js';
import languages from '../../locales/languages.js';
import { initializePostgreSQL } from '../db.js';
import { resolveAuthUserId } from './auth.js';
import {
  type BlogPostDeleteInput,
  type BlogPostDiffInput,
  type BlogPostUpdateInput,
  type BlogPostWriteInput,
  createBlogPost,
  deleteBlogPost,
  diffBlogPostRevisions,
  listBlogPostResources,
  listBlogPostRevisions,
  readBlogPost,
  readBlogPostRevision,
  updateBlogPost,
} from './blog-handlers.js';
import {
  InvalidRequestError,
  toToolErrorPayload,
  toValidationErrorFromZod,
  UnsupportedError,
} from './errors.js';
import {
  addWikiPageAlias,
  applyWikiPagePatch,
  type CitationDeleteInput,
  type CitationQueryInput,
  type CitationUpdateInput,
  type CitationWriteInput,
  createCitation,
  createWikiPage,
  deleteCitation,
  deleteWikiPage,
  diffCitationRevisions,
  diffWikiPageRevisions,
  listCitationRevisions,
  listWikiPageResources,
  listWikiPageRevisions,
  queryCitations,
  readCitation,
  readCitationRevision,
  readWikiPage,
  readWikiPageRevision,
  removeWikiPageAlias,
  rewriteWikiPageSection,
  updateCitation,
  updateWikiPage,
  type WikiPageAliasInput,
  type WikiPageDeleteInput,
  type WikiPagePatchInput,
  type WikiPageRewriteSectionInput,
  type WikiPageUpdateInput,
  type WikiPageWriteInput,
} from './handlers.js';
import { registerPrompts } from './prompts.js';
import { BLOG_ADMIN_ROLE, hasRole, WIKI_ADMIN_ROLE } from './roles.js';
import { createLocalizedSchemas } from './schema.js';

export type FormatToolResult = (payload: unknown) => CallToolResult;

export interface CreateMcpServerOptions {
  userRoles?: string[];
}

const ensureMcpErrorMap = () => {
  const existing = z.getErrorMap();
  if (existing && (existing as { __agpwikiMcp?: boolean }).__agpwikiMcp) return;

  const mcpErrorMap: z.ZodErrorMap = issue => {
    const field = issue.path?.length ? issue.path.join('.') : 'value';
    if (issue.code === 'invalid_type') {
      if (issue.input === undefined) {
        return { message: `${field} is required.` };
      }
      if (issue.expected === 'string') {
        return { message: `${field} must be a string.` };
      }
      if (issue.expected === 'record' || issue.expected === 'object') {
        return { message: `${field} must be an object.` };
      }
    }

    const fallbackMessage = issue.message ?? 'Invalid input.';
    return { message: fallbackMessage };
  };

  (mcpErrorMap as { __agpwikiMcp?: boolean }).__agpwikiMcp = true;
  z.setErrorMap(mcpErrorMap);
};

const normalizeToolSchema = (schema: unknown): z.ZodTypeAny | undefined => {
  if (!schema || typeof schema !== 'object') return undefined;
  const asAny = schema as Record<string, unknown> & {
    _def?: unknown;
    _zod?: unknown;
    safeParse?: unknown;
    safeParseAsync?: unknown;
  };
  if (asAny._def || asAny._zod || typeof asAny.safeParse === 'function') {
    return schema as z.ZodTypeAny;
  }

  const values = Object.values(schema as Record<string, unknown>);
  if (
    values.length === 0 ||
    values.every(
      value =>
        value &&
        typeof value === 'object' &&
        ('_def' in (value as Record<string, unknown>) ||
          '_zod' in (value as Record<string, unknown>) ||
          typeof (value as { safeParse?: unknown }).safeParse === 'function')
    )
  ) {
    return z.object(schema as z.ZodRawShape);
  }

  return undefined;
};

export const createMcpServer = (options: CreateMcpServerOptions = {}) => {
  ensureMcpErrorMap();
  const { userRoles = [] } = options;
  const uuidSchema = z.string().uuid({ message: 'Must be a valid UUID.' });
  const server = new McpServer(
    {
      name: 'agpwiki',
      version: '0.1.0',
    },
    {
      instructions: 'Use tools to create/update wiki pages and citations, and resources to read them.',
    }
  );

  const formatToolResult: FormatToolResult = payload => {
    const structuredContent =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : { value: payload };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent,
    };
  };

  const formatToolErrorResult = (error: unknown): CallToolResult => {
    const payload = toToolErrorPayload(error);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
      structuredContent: payload,
      isError: true,
    };
  };

  const withToolErrorHandling =
    <Args,>(handler: (args: Args, extra?: { authInfo?: AuthInfo }) => Promise<unknown>) =>
    async (args: Args, extra?: { authInfo?: AuthInfo }) => {
      try {
        const payload = await handler(args, extra);
        return formatToolResult(payload);
      } catch (error) {
        return formatToolErrorResult(error);
      }
    };

  const requireAuthUserId = async (extra?: { authInfo?: AuthInfo }) =>
    resolveAuthUserId({ authInfo: extra?.authInfo });

  const getAgentTags = () => {
    const info = server.server.getClientVersion();
    if (!info?.name) return [];
    const name = info.name.trim();
    if (!name) return [];
    const safe = name.replace(/\s+/g, '-').toLowerCase();
    const tags = [`agent:${safe}`];
    if (info.version) {
      tags.push(`agent_version:${info.version}`);
    }
    return tags;
  };

  const mergeTags = (tags?: string[]) => {
    const agentTags = getAgentTags();
    if (!agentTags.length) return tags;
    return [...agentTags, ...(tags ?? [])];
  };

  const {
    localizedTitleSchema,
    localizedBodySchema,
    localizedSummarySchema,
    localizedRevisionSummarySchema,
    languageTagSchema,
  } = createLocalizedSchemas();

  server.registerResource(
    'Wiki Pages Index',
    'agpwiki://pages',
    {
      title: 'Wiki Pages Index',
      description: 'List all wiki pages with metadata.',
      mimeType: 'application/json',
    },
    async uri => {
      const dal = await initializePostgreSQL();
      const listing = await listWikiPageResources(dal);

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(listing.resources, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'Blog Posts Index',
    'agpwiki://blog/posts',
    {
      title: 'Blog Posts Index',
      description: 'List all blog posts with metadata.',
      mimeType: 'application/json',
    },
    async uri => {
      const dal = await initializePostgreSQL();
      const listing = await listBlogPostResources(dal);

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(listing.resources, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'Supported Locales',
    'agpwiki://locales',
    {
      title: 'Supported Locales',
      description:
        'List supported locale codes and localized display names. Optionally pass ?uiLocale=xx to get labels in that language.',
      mimeType: 'application/json',
    },
    async uri => {
      const uiLocale = uri.searchParams.get('uiLocale') ?? 'en';
      if (!languages.isValid(uiLocale)) {
        throw new Error(
          `Unsupported uiLocale "${uiLocale}". Use agpwiki://locales for supported locale codes.`
        );
      }

      const supportedLocales = languages.getValidLanguages();
      const options = getLanguageOptions(uiLocale as AgpWiki.LocaleCode);
      const labelsByCode = Object.fromEntries(options.map(option => [option.code, option.label]));

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                uiLocale,
                supportedLocales,
                options,
                labelsByCode,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    'wiki_createPage',
    {
      title: 'Create Wiki Page',
      description:
        'Create a new wiki page with initial content. Localized fields use language-keyed maps keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Title"}.',
      inputSchema: {
        slug: z.string(),
        title: localizedTitleSchema.optional,
        body: localizedBodySchema.optional,
        originalLanguage: languageTagSchema.optionalNullable,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.optional,
      },
    },
    withToolErrorHandling(async (args: WikiPageWriteInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await createWikiPage(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return payload;
    })
  );

  server.registerTool(
    'citation_create',
    {
      title: 'Create Citation',
      description:
        'Create a new citation entry with CSL JSON data. revSummary uses a language-keyed map keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Create citation"}.',
      inputSchema: {
        key: z.string(),
        data: z.record(z.string(), z.unknown()),
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.optional,
      },
    },
    withToolErrorHandling(async (args: CitationWriteInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await createCitation(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return payload;
    })
  );

  server.registerTool(
    'citation_query',
    {
      title: 'Query Citations',
      description: 'Search citations by key prefix, title, author, year, DOI, or URL.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        keyPrefix: z.string().optional(),
        title: z.string().optional(),
        author: z.string().optional(),
        year: z.number().int().optional(),
        yearFrom: z.number().int().optional(),
        yearTo: z.number().int().optional(),
        doi: z.string().optional(),
        url: z.string().optional(),
        domain: z.string().optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    withToolErrorHandling(async (args: CitationQueryInput) => {
      const dal = await initializePostgreSQL();
      const payload = await queryCitations(dal, args);
      return payload;
    })
  );

  server.registerTool(
    'blog_createPost',
    {
      title: 'Create Blog Post',
      description:
        'Create a new blog post with initial content. Localized fields use language-keyed maps keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Title"}.',
      inputSchema: {
        slug: z.string(),
        title: localizedTitleSchema.optional,
        body: localizedBodySchema.optional,
        summary: localizedSummarySchema.optional,
        originalLanguage: languageTagSchema.optionalNullable,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.optional,
      },
    },
    withToolErrorHandling(async (args: BlogPostWriteInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await createBlogPost(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return payload;
    })
  );

  server.registerTool(
    'blog_updatePost',
    {
      title: 'Update Blog Post',
      description:
        'Create a new revision for an existing blog post. Localized fields use language-keyed maps keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Title"}. revSummary is required, e.g., {"en":"Clarify expedition timeline per source A"}.',
      inputSchema: {
        slug: z.string(),
        newSlug: z.string().optional(),
        title: localizedTitleSchema.optional,
        body: localizedBodySchema.optional,
        summary: localizedSummarySchema.optional,
        originalLanguage: languageTagSchema.optionalNullable,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: BlogPostUpdateInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await updateBlogPost(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return payload;
    })
  );

  server.registerTool(
    'blog_listRevisions',
    {
      title: 'List Blog Post Revisions',
      description: 'List revisions for a blog post by slug.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
      },
    },
    withToolErrorHandling(async (args: { slug: string }) => {
      const dal = await initializePostgreSQL();
      const payload = await listBlogPostRevisions(dal, args.slug);
      return payload;
    })
  );

  server.registerTool(
    'blog_diffRevisions',
    {
      title: 'Diff Blog Post Revisions',
      description: 'Generate a unified diff between two blog post revisions.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
        fromRevId: uuidSchema,
        toRevId: uuidSchema.optional(),
        lang: languageTagSchema.optional,
      },
    },
    withToolErrorHandling(async (args: BlogPostDiffInput) => {
      const dal = await initializePostgreSQL();
      const payload = await diffBlogPostRevisions(dal, args);
      return payload;
    })
  );

  server.registerTool(
    'blog_readPost',
    {
      title: 'Read Blog Post',
      description: 'Read a single blog post by slug.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
      },
    },
    withToolErrorHandling(async (args: { slug: string }) => {
      const dal = await initializePostgreSQL();
      const payload = await readBlogPost(dal, args.slug);
      return payload;
    })
  );

  server.registerTool(
    'blog_readRevision',
    {
      title: 'Read Blog Post Revision',
      description: 'Read a specific blog post revision by revision ID.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
        revId: uuidSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readBlogPostRevision(dal, args.slug, args.revId);
      return payload;
    })
  );

  const blogDeleteTool = server.registerTool(
    'blog_deletePost',
    {
      title: 'Delete Blog Post',
      description:
        'Soft-delete a blog post and all its revisions. Requires blog_admin role. revSummary is required, e.g., {"en":"Remove duplicate draft of biographical post"}.',
      inputSchema: {
        slug: z.string(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: BlogPostDeleteInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await deleteBlogPost(dal, { ...args }, userId);
      return payload;
    })
  );

  server.registerTool(
    'citation_listRevisions',
    {
      title: 'List Citation Revisions',
      description: 'List revisions for a citation by key.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        key: z.string(),
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await listCitationRevisions(dal, args.key);
      return payload;
    })
  );

  server.registerTool(
    'citation_diffRevisions',
    {
      title: 'Diff Citation Revisions',
      description: 'Generate a unified diff between two citation revisions.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        key: z.string(),
        fromRevId: uuidSchema,
        toRevId: uuidSchema.optional(),
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await diffCitationRevisions(dal, args);
      return payload;
    })
  );

  server.registerTool(
    'citation_read',
    {
      title: 'Read Citation',
      description: 'Read a citation by key.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        key: z.string(),
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readCitation(dal, args.key);
      return payload;
    })
  );

  server.registerTool(
    'citation_readRevision',
    {
      title: 'Read Citation Revision',
      description: 'Read a specific citation revision by revision ID.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        key: z.string(),
        revId: uuidSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readCitationRevision(dal, args.key, args.revId);
      return payload;
    })
  );

  server.registerTool(
    'citation_update',
    {
      title: 'Update Citation',
      description:
        'Create a new revision for an existing citation. revSummary uses a language-keyed map keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Update citation"}.',
      inputSchema: {
        key: z.string(),
        newKey: z.string().optional(),
        data: z.record(z.string(), z.unknown()).nullable().optional(),
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: CitationUpdateInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await updateCitation(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return payload;
    })
  );

  server.registerTool(
    'wiki_listRevisions',
    {
      title: 'List Wiki Page Revisions',
      description: 'List revisions for a wiki page by slug.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await listWikiPageRevisions(dal, args.slug);
      return payload;
    })
  );

  server.registerTool(
    'wiki_diffRevisions',
    {
      title: 'Diff Wiki Page Revisions',
      description: 'Generate a unified diff between two revisions.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
        fromRevId: uuidSchema,
        toRevId: uuidSchema.optional(),
        lang: languageTagSchema.optional,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await diffWikiPageRevisions(dal, args);
      return payload;
    })
  );

  server.registerTool(
    'wiki_readPage',
    {
      title: 'Read Wiki Page',
      description: 'Read a single wiki page by slug.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readWikiPage(dal, args.slug);
      return payload;
    })
  );

  server.registerTool(
    'wiki_readRevision',
    {
      title: 'Read Wiki Page Revision',
      description: 'Read a specific wiki page revision by revision ID.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
        revId: uuidSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readWikiPageRevision(dal, args.slug, args.revId);
      return payload;
    })
  );

  server.registerTool(
    'wiki_applyPatch',
    {
      title: 'Apply Wiki Patch',
      description:
        'Apply a patch to a wiki page body. Use format "unified" (---/+++ with @@ hunks) or "codex" (*** Begin Patch). revSummary is required, e.g., {"en":"Fix date in lead per cited archive"}.',
      inputSchema: {
        slug: z.string(),
        patch: z.string(),
        format: z.enum(['unified', 'codex']),
        lang: languageTagSchema.optional,
        baseRevId: uuidSchema.optional(),
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: WikiPagePatchInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await applyWikiPagePatch(
        dal,
        { ...args, tags: mergeTags(args.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'wiki_rewriteSection',
    {
      title: 'Rewrite Wiki Section',
      description:
        'Rewrite a specific section of a wiki page body by heading text. Heading matching is strict and case-sensitive. revSummary is required, e.g., {"en":"Rewrite \'Legacy\' section to match sources"}.',
      inputSchema: {
        slug: z.string(),
        heading: z.string(),
        headingLevel: z.number().int().min(1).max(6).optional(),
        occurrence: z.number().int().min(1).optional(),
        mode: z.enum(['replace', 'prepend', 'append']).optional(),
        content: z.string(),
        lang: languageTagSchema.optional,
        expectedRevId: uuidSchema.optional(),
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: WikiPageRewriteSectionInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await rewriteWikiPageSection(
        dal,
        { ...args, tags: mergeTags(args.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'wiki_updatePage',
    {
      title: 'Update Wiki Page',
      description:
        'Create a new revision for an existing wiki page. Localized fields use language-keyed maps keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Title"}. revSummary is required, e.g., {"en":"Add 2022 census figures with citations"}.',
      inputSchema: {
        slug: z.string(),
        newSlug: z.string().optional(),
        title: localizedTitleSchema.optional,
        body: localizedBodySchema.optional,
        originalLanguage: languageTagSchema.optionalNullable,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: WikiPageUpdateInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await updateWikiPage(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return payload;
    })
  );

  server.registerTool(
    'wiki_addAlias',
    {
      title: 'Add Wiki Page Alias',
      description: 'Create a new alias slug for an existing wiki page.',
      inputSchema: {
        slug: z.string(),
        pageSlug: z.string(),
        lang: languageTagSchema.optional,
      },
    },
    withToolErrorHandling(async (args: WikiPageAliasInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await addWikiPageAlias(dal, args, userId);
      return payload;
    })
  );

  server.registerTool(
    'wiki_removeAlias',
    {
      title: 'Remove Wiki Page Alias',
      description: 'Remove an alias slug from a wiki page.',
      inputSchema: {
        slug: z.string(),
      },
    },
    withToolErrorHandling(async (args: { slug: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await removeWikiPageAlias(dal, args.slug, userId);
      return payload;
    })
  );

  const wikiDeletePageTool = server.registerTool(
    'wiki_deletePage',
    {
      title: 'Delete Wiki Page',
      description:
        'Soft-delete a wiki page and all its revisions. Requires wiki_admin role. revSummary is required, e.g., {"en":"Remove hoax article; fails reliability policy"}.',
      inputSchema: {
        slug: z.string(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: WikiPageDeleteInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await deleteWikiPage(dal, { ...args }, userId);
      return payload;
    })
  );

  const citationDeleteTool = server.registerTool(
    'citation_delete',
    {
      title: 'Delete Citation',
      description:
        'Soft-delete a citation and all its revisions. Requires wiki_admin role. revSummary is required, e.g., {"en":"Delete broken URL; replaced by archived source"}.',
      inputSchema: {
        key: z.string(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: CitationDeleteInput, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await deleteCitation(dal, { ...args }, userId);
      return payload;
    })
  );

  const adminTools = { wikiDeletePageTool, citationDeleteTool, blogDeleteTool };

  if (!hasRole(userRoles, WIKI_ADMIN_ROLE)) {
    wikiDeletePageTool.disable();
    citationDeleteTool.disable();
  }
  if (!hasRole(userRoles, BLOG_ADMIN_ROLE)) {
    blogDeleteTool.disable();
  }

  registerPrompts(server);

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    type RegisteredTool = {
      enabled: boolean;
      inputSchema?: unknown;
      handler:
        | ((args: unknown, extra?: { authInfo?: AuthInfo }) => Promise<CallToolResult> | CallToolResult)
        | ((extra?: { authInfo?: AuthInfo }) => Promise<CallToolResult> | CallToolResult);
    };

    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
    const toolName = request.params.name;
    const tool = tools[toolName];

    if (!tool) {
      return formatToolErrorResult(new InvalidRequestError(`Tool ${toolName} not found.`));
    }

    if (!tool.enabled) {
      return formatToolErrorResult(new InvalidRequestError(`Tool ${toolName} disabled.`));
    }

    if (request.params.task) {
      return formatToolErrorResult(
        new UnsupportedError(`Tool ${toolName} does not support task augmentation.`)
      );
    }

    let parsedArgs: unknown = request.params.arguments;
    if (tool.inputSchema) {
      const schema = normalizeToolSchema(tool.inputSchema);
      if (schema) {
        const parseResult = await schema.safeParseAsync(parsedArgs);
        if (!parseResult.success) {
          return formatToolErrorResult(
            toValidationErrorFromZod(
              `Invalid arguments for tool ${toolName}.`,
              parseResult.error.issues as {
                code: string;
                path?: Array<string | number>;
                message: string;
                input?: unknown;
              }[]
            )
          );
        }
        parsedArgs = parseResult.data;
      }
    }

    try {
      const handler = tool.handler;
      if (tool.inputSchema) {
        return await Promise.resolve(handler(parsedArgs, extra));
      }
      return await Promise.resolve(handler(extra));
    } catch (error) {
      return formatToolErrorResult(error);
    }
  });

  // Override the SDK's resource handler to provide helpful error messages
  // when clients use incorrect URI formats
  type RegisteredResource = {
    enabled: boolean;
    readCallback: (uri: URL, extra: unknown) => Promise<ReadResourceResult>;
  };
  type RegisteredTemplate = {
    resourceTemplate: { uriTemplate: { match: (uri: string) => Record<string, string> | null } };
    readCallback: (
      uri: URL,
      variables: Record<string, string>,
      extra: unknown
    ) => Promise<ReadResourceResult>;
  };

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const uri = new URL(request.params.uri);

    // Access private registries (fragile but necessary for custom error handling)
    const mcpServer = server as unknown as {
      _registeredResources: Record<string, RegisteredResource>;
      _registeredResourceTemplates: Record<string, RegisteredTemplate>;
    };

    // Check for exact resource match
    const resource = mcpServer._registeredResources[uri.toString()];
    if (resource) {
      if (!resource.enabled) {
        throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} disabled`);
      }
      return resource.readCallback(uri, extra);
    }

    // Check templates
    for (const template of Object.values(mcpServer._registeredResourceTemplates)) {
      const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
      if (variables) {
        return template.readCallback(uri, variables, extra);
      }
    }

    // No match found - provide helpful error message
    throw new McpError(
      ErrorCode.InvalidParams,
      `Resource not found: ${uri}. Available resources: agpwiki://pages, agpwiki://blog/posts, agpwiki://locales. To read individual items, use tools: wiki_readPage, blog_readPost, citation_read.`
    );
  });

  return { server, formatToolResult, formatToolErrorResult, adminTools };
};
