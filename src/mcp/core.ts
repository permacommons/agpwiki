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
import {
  CITATION_CLAIM_ASSERTION_MAX_LENGTH,
  CITATION_CLAIM_LOCATOR_LABEL_MAX_LENGTH,
  CITATION_CLAIM_LOCATOR_TYPES,
  CITATION_CLAIM_LOCATOR_VALUE_MAX_LENGTH,
  CITATION_CLAIM_QUOTE_MAX_LENGTH,
} from '../lib/citation-claims.js';
import {
  InvalidRequestError,
  PreconditionFailedError,
  UnsupportedError,
} from '../lib/errors.js';
import {
  PAGE_CHECK_NOTES_MAX_LENGTH,
  PAGE_CHECK_RESULTS_MAX_LENGTH,
  PAGE_CHECK_STATUSES,
  PAGE_CHECK_TYPES,
} from '../lib/page-checks.js';
import { canUseBlogAdminTools, canUseWikiAdminTools } from '../services/authorization.js';
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
} from '../services/blog-post-service.js';
import {
  type CitationClaimDeleteInput,
  type CitationClaimDiffInput,
  type CitationClaimUpdateInput,
  type CitationClaimWriteInput,
  createCitationClaim,
  deleteCitationClaim,
  diffCitationClaimRevisions,
  listCitationClaimRevisions,
  readCitationClaim,
  readCitationClaimRevision,
  updateCitationClaim,
} from '../services/citation-claim-service.js';
import {
  type CitationDeleteInput,
  type CitationQueryInput,
  type CitationUpdateInput,
  type CitationWriteInput,
  createCitation,
  deleteCitation,
  diffCitationRevisions,
  listCitationRevisions,
  queryCitations,
  readCitation,
  readCitationRevision,
  updateCitation,
} from '../services/citation-service.js';
import {
  createMedia,
  deleteMedia,
  diffMediaRevisions,
  listMediaRevisions,
  type MediaDeleteInput,
  type MediaQueryInput,
  type MediaRefreshInput,
  type MediaUpdateInput,
  type MediaWriteInput,
  queryMedia,
  readMedia,
  readMediaRevision,
  refreshMedia,
  updateMedia,
} from '../services/media-service.js';
import { getMediaStorage } from '../services/media-storage-backend.js';
import {
  createPageCheck,
  deletePageCheck,
  diffPageCheckRevisions,
  listPageCheckRevisions,
  listPageChecks,
  type PageCheckDeleteInput,
  type PageCheckUpdateInput,
  type PageCheckWriteInput,
  readPageCheckRevision,
  updatePageCheck,
} from '../services/page-check-service.js';
import {
  addWikiPageAlias,
  applyWikiPagePatch,
  createWikiPage,
  deleteWikiPage,
  diffWikiPageRevisions,
  listWikiPageResources,
  listWikiPageRevisions,
  readWikiPage,
  readWikiPageRevision,
  removeWikiPageAlias,
  replaceWikiPageExactText,
  rewriteWikiPageSection,
  updateWikiPage,
  type WikiPageAliasInput,
  type WikiPageDeleteInput,
  type WikiPagePatchInput,
  type WikiPageReplaceExactTextInput,
  type WikiPageRewriteSectionInput,
  type WikiPageUpdateInput,
  type WikiPageWriteInput,
} from '../services/wiki-page-service.js';
import { resolveAuthUserId } from './auth.js';
import { toToolErrorPayload, toValidationErrorFromZod } from './errors.js';
import { registerPrompts } from './prompts.js';
import { createLocalizedSchemas } from './schema.js';

export type FormatToolResult = (payload: unknown) => CallToolResult;

export interface CreateMcpServerOptions {
  userRoles?: string[];
}

const POLICY_PAGE_SLUG = 'meta/policy';
const POLICY_HASH_ERROR_MESSAGE =
  'Use wiki_readPage to read /meta/policy and linked pages that are marked required reading, then submit the contentHash for /meta/policy.';
const SLUG_MAX_LENGTH = 200;
const TITLE_MAX_LENGTH = 200;
const BODY_MAX_LENGTH = 20000;
const BLOG_SUMMARY_MAX_LENGTH = 500;
const REV_SUMMARY_MAX_LENGTH = 300;
const CITATION_KEY_MAX_LENGTH = 200;
const CITATION_CLAIM_ID_MAX_LENGTH = 200;
const LANGUAGE_TAG_MAX_LENGTH = 8;
const CITATION_CLAIM_LOCATOR_TYPE_MAX_LENGTH = 32;
const PAGE_CHECK_TYPE_MAX_LENGTH = 64;
const PAGE_CHECK_STATUS_MAX_LENGTH = 32;

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
  const slugSchema = z.string().describe(`Wiki/blog slug. Max ${SLUG_MAX_LENGTH} characters.`);
  const citationKeySchema = z
    .string()
    .describe(`Citation key. Max ${CITATION_KEY_MAX_LENGTH} characters.`);
  const citationClaimIdSchema = z
    .string()
    .describe(`Citation claim ID. Max ${CITATION_CLAIM_ID_MAX_LENGTH} characters.`);
  const optionalSlugSchema = slugSchema.optional().describe(slugSchema.description ?? '');
  const optionalCitationKeySchema = citationKeySchema
    .optional()
    .describe(citationKeySchema.description ?? '');
  const optionalCitationClaimIdSchema = citationClaimIdSchema
    .optional()
    .describe(citationClaimIdSchema.description ?? '');
  const pageCheckTypeSchema = z
    .string()
    .refine(
      value => PAGE_CHECK_TYPES.includes(value as (typeof PAGE_CHECK_TYPES)[number]),
      {
        message: `Must be one of: ${PAGE_CHECK_TYPES.join(', ')}.`,
      }
    )
    .describe(
      `Page check type. Must be one of: ${PAGE_CHECK_TYPES.join(', ')}. Max ${PAGE_CHECK_TYPE_MAX_LENGTH} characters.`
    );
  const pageCheckStatusSchema = z
    .enum([...PAGE_CHECK_STATUSES] as [string, ...string[]])
    .describe(
      `Page check status. Must be one of: ${PAGE_CHECK_STATUSES.join(', ')}. Max ${PAGE_CHECK_STATUS_MAX_LENGTH} characters.`
    );
  const claimLocatorTypeSchema = z
    .enum([...CITATION_CLAIM_LOCATOR_TYPES] as [string, ...string[]])
    .optional()
    .nullable()
    .describe(
      `Citation locator type. Must be one of: ${CITATION_CLAIM_LOCATOR_TYPES.join(', ')}. Max ${CITATION_CLAIM_LOCATOR_TYPE_MAX_LENGTH} characters.`
    );
  const server = new McpServer(
    {
      name: 'agpwiki',
      version: '0.1.0',
    },
    {
      instructions: 'Use tools to create/update wiki pages, citations, and media (Wikimedia Commons), and resources to read them.',
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

  const requireCurrentPolicyHash = async (
    dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
    policyHash?: string
  ) => {
    const policyPage = await readWikiPage(dal, POLICY_PAGE_SLUG);
    if (policyHash === policyPage.contentHash) return;
    throw new PreconditionFailedError(POLICY_HASH_ERROR_MESSAGE, {
      requiredPageSlug: POLICY_PAGE_SLUG,
      requiredParam: 'policyHash',
    });
  };

  const {
    localizedTitleSchema,
    localizedBodySchema,
    localizedSummarySchema,
    localizedAssertionSchema,
    localizedQuoteSchema,
    localizedLocatorValueSchema,
    localizedLocatorLabelSchema,
    localizedCheckResultsSchema,
    localizedNotesSchema,
    localizedCaptionSchema,
    localizedAltTextSchema,
    localizedRevisionSummarySchema,
    languageTagSchema,
  } = createLocalizedSchemas({
    languageTagMaxLength: LANGUAGE_TAG_MAX_LENGTH,
    localized: {
      title: { maxLength: TITLE_MAX_LENGTH },
      body: { descriptionSuffix: 'Each value is Markdown.', maxLength: BODY_MAX_LENGTH },
      summary: { maxLength: BLOG_SUMMARY_MAX_LENGTH },
      assertion: { maxLength: CITATION_CLAIM_ASSERTION_MAX_LENGTH },
      quote: { maxLength: CITATION_CLAIM_QUOTE_MAX_LENGTH },
      locatorValue: { maxLength: CITATION_CLAIM_LOCATOR_VALUE_MAX_LENGTH },
      locatorLabel: { maxLength: CITATION_CLAIM_LOCATOR_LABEL_MAX_LENGTH },
      checkResults: { maxLength: PAGE_CHECK_RESULTS_MAX_LENGTH },
      notes: { maxLength: PAGE_CHECK_NOTES_MAX_LENGTH },
      revSummary: { maxLength: REV_SUMMARY_MAX_LENGTH },
    },
  });

  const pageCheckMetricsSchema = z
    .object({
      issues_found: z
        .object({
          high: z.number().int().min(0),
          medium: z.number().int().min(0),
          low: z.number().int().min(0),
        })
        .strict(),
      issues_fixed: z
        .object({
          high: z.number().int().min(0),
          medium: z.number().int().min(0),
          low: z.number().int().min(0),
        })
        .strict(),
    })
    .strict()
    .superRefine((value, ctx) => {
      (['high', 'medium', 'low'] as const).forEach(level => {
        if (value.issues_fixed[level] > value.issues_found[level]) {
          ctx.addIssue({
            code: 'custom',
            path: ['issues_fixed', level],
            message: `issues_fixed.${level} must be less than or equal to issues_found.${level}.`,
          });
        }
      });
    });

  const notesDescription = 'Optional; leave empty if not needed.';
  const rewriteContentDescription =
    'Section content to write. For target "heading", provide body text only; the heading line is preserved automatically. For target "lead", this replaces/prepends/appends the lead text before the first heading.';
  const policyHashSchema = z
    .string()
    .describe(
      'Use wiki_readPage to read /meta/policy and linked pages that are marked required reading, then submit the contentHash for /meta/policy.'
    );

  // MCP tool annotation policy:
  // - readOnlyHint: true only for tools that do not mutate AGPWiki state.
  // - destructiveHint: false for additive writes such as creates and alias additions.
  // - destructiveHint: true for writes that change current visible state, remove access, or refresh stored metadata.
  // - openWorldHint: true only for tools that call external services during the tool call.
  // - idempotentHint: omitted because AGPWiki write retries are not a supported contract.
  const readOnlyToolAnnotations = {
    readOnlyHint: true,
    openWorldHint: false,
  } as const;
  const additiveWriteToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  } as const;
  const destructiveWriteToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  } as const;
  const externalAdditiveWriteToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  } as const;
  const externalDestructiveWriteToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  } as const;

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
            text: JSON.stringify(listing, null, 2),
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
            text: JSON.stringify(listing, null, 2),
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
        'Create a new wiki page with initial content. Localized fields use language-keyed maps keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Title"}. Before making edits, review policies linked from /meta/policy.',
      annotations: additiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        title: localizedTitleSchema.optional,
        body: localizedBodySchema.optional,
        originalLanguage: languageTagSchema.optionalNullable,
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.optional,
      },
    },
    withToolErrorHandling(async (args: WikiPageWriteInput & { policyHash?: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await createWikiPage(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'citation_create',
    {
      title: 'Create Citation',
      description:
        'Create a new citation entry with CSL JSON data. data.id is ignored; the citation key is authoritative for identity. revSummary uses a language-keyed map keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Create citation"}.',
      annotations: additiveWriteToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        data: z.record(z.string(), z.unknown()),
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.optional,
      },
    },
    withToolErrorHandling(async (args: CitationWriteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await createCitation(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'citation_query',
    {
      title: 'Query Citations',
      description: 'Search citations by key prefix, title, author, year, DOI, or URL.',
      annotations: readOnlyToolAnnotations,
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
      annotations: additiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        newSlug: optionalSlugSchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
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
        'Create a new revision for an existing citation. data.id is ignored; the citation key is authoritative for identity. revSummary is required and uses a language-keyed map keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Update citation"}.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        newKey: optionalCitationKeySchema,
        data: z.record(z.string(), z.unknown()).optional(),
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: CitationUpdateInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await updateCitation(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'claim_create',
    {
      title: 'Create Citation Claim',
      description:
        'Create a new claim linked to a citation. assertion and quote are localized plain-text maps (not Markdown). quoteLanguage identifies the source language when quote is provided. revSummary uses a language-keyed map keyed by supported locale codes (see agpwiki://locales).',
      annotations: additiveWriteToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        claimId: citationClaimIdSchema,
        assertion: localizedAssertionSchema.required,
        quote: localizedQuoteSchema.optional,
        quoteLanguage: languageTagSchema.optionalNullable,
        locatorType: claimLocatorTypeSchema,
        locatorValue: localizedLocatorValueSchema.optional,
        locatorLabel: localizedLocatorLabelSchema.optional,
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.optional,
      },
    },
    withToolErrorHandling(async (args: CitationClaimWriteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await createCitationClaim(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'claim_update',
    {
      title: 'Update Citation Claim',
      description:
        'Create a new revision for an existing claim. assertion and quote are localized plain-text maps (not Markdown). quoteLanguage identifies the source language when quote is provided. revSummary is required.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        claimId: citationClaimIdSchema,
        newClaimId: optionalCitationClaimIdSchema,
        assertion: localizedAssertionSchema.optional,
        quote: localizedQuoteSchema.optional,
        quoteLanguage: languageTagSchema.optionalNullable,
        locatorType: claimLocatorTypeSchema,
        locatorValue: localizedLocatorValueSchema.optional,
        locatorLabel: localizedLocatorLabelSchema.optional,
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: CitationClaimUpdateInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await updateCitationClaim(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'claim_listRevisions',
    {
      title: 'List Citation Claim Revisions',
      description: 'List revisions for a citation claim by key and claimId.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        claimId: citationClaimIdSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await listCitationClaimRevisions(dal, args.key, args.claimId);
      return payload;
    })
  );

  server.registerTool(
    'claim_diffRevisions',
    {
      title: 'Diff Citation Claim Revisions',
      description: 'Generate a unified diff between two citation claim revisions.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        claimId: citationClaimIdSchema,
        fromRevId: uuidSchema,
        toRevId: uuidSchema.optional(),
        lang: languageTagSchema.optional,
      },
    },
    withToolErrorHandling(async (args: CitationClaimDiffInput) => {
      const dal = await initializePostgreSQL();
      const payload = await diffCitationClaimRevisions(dal, args);
      return payload;
    })
  );

  server.registerTool(
    'claim_read',
    {
      title: 'Read Citation Claim',
      description: 'Read a citation claim by key and claimId.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        claimId: citationClaimIdSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readCitationClaim(dal, args.key, args.claimId);
      return payload;
    })
  );

  server.registerTool(
    'claim_readRevision',
    {
      title: 'Read Citation Claim Revision',
      description: 'Read a specific citation claim revision by revision ID.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        claimId: citationClaimIdSchema,
        revId: uuidSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readCitationClaimRevision(dal, args.key, args.claimId, args.revId);
      return payload;
    })
  );

  server.registerTool(
    'wiki_listRevisions',
    {
      title: 'List Wiki Page Revisions',
      description: 'List revisions for a wiki page by slug.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
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
    'media_create',
    {
      title: 'Create Media',
      description:
        'Register a Wikimedia Commons image as a media entity. The server fetches Commons metadata such as license, attribution, dimensions, and thumbnail template. Use the returned slug in article markdown as `![Alt text](/media/<slug>){size=250 caption="..."}`. Only images are supported.',
      annotations: externalAdditiveWriteToolAnnotations,
      inputSchema: {
        slug: z.string(),
        commonsTitle: z.string(),
        title: localizedTitleSchema.optional,
        caption: localizedCaptionSchema.optional,
        altText: localizedAltTextSchema.optional,
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.optional,
      },
    },
    withToolErrorHandling(async (args: MediaWriteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await createMedia(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'media_update',
    {
      title: 'Update Media',
      description:
        'Create a new revision for an existing media entity. Updates curated fields only: slug, title, caption, and altText. Use media_refresh to re-fetch Commons metadata.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: z.string(),
        newSlug: z.string().optional(),
        title: localizedTitleSchema.optional,
        caption: localizedCaptionSchema.optional,
        altText: localizedAltTextSchema.optional,
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: MediaUpdateInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await updateMedia(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId,
        { storage: getMediaStorage() }
      );
      return payload;
    })
  );

  server.registerTool(
    'media_refresh',
    {
      title: 'Refresh Media Metadata',
      description:
        'Re-fetch Commons metadata for an existing media entity and store it as a new revision. Cached thumbnails are invalidated and rebuilt on demand.',
      annotations: externalDestructiveWriteToolAnnotations,
      inputSchema: {
        slug: z.string(),
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: MediaRefreshInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await refreshMedia(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId,
        { storage: getMediaStorage() }
      );
      return payload;
    })
  );

  server.registerTool(
    'media_query',
    {
      title: 'Query Media',
      description:
        'Search media entities by slug prefix, Commons title substring, license, or author. Only images are supported in this release.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slugPrefix: z.string().optional(),
        commonsTitle: z.string().optional(),
        mediaType: z.literal('image').optional(),
        license: z.string().optional(),
        author: z.string().optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    withToolErrorHandling(async (args: unknown) => {
      const dal = await initializePostgreSQL();
      const payload = await queryMedia(dal, args as MediaQueryInput);
      return payload;
    })
  );

  server.registerTool(
    'media_read',
    {
      title: 'Read Media',
      description: 'Read a media entity by slug.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: z.string(),
      },
    },
    withToolErrorHandling(async (args: { slug: string }) => {
      const dal = await initializePostgreSQL();
      const payload = await readMedia(dal, args.slug);
      return payload;
    })
  );

  server.registerTool(
    'media_readRevision',
    {
      title: 'Read Media Revision',
      description: 'Read a specific media revision by revision ID.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: z.string(),
        revId: uuidSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readMediaRevision(dal, args.slug, args.revId);
      return payload;
    })
  );

  server.registerTool(
    'media_listRevisions',
    {
      title: 'List Media Revisions',
      description: 'List revisions for a media entity by slug.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: z.string(),
      },
    },
    withToolErrorHandling(async (args: { slug: string }) => {
      const dal = await initializePostgreSQL();
      const payload = await listMediaRevisions(dal, args.slug);
      return payload;
    })
  );

  server.registerTool(
    'media_diffRevisions',
    {
      title: 'Diff Media Revisions',
      description: 'Generate a structured diff between two media revisions.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: z.string(),
        fromRevId: uuidSchema,
        toRevId: uuidSchema.optional(),
      },
    },
    withToolErrorHandling(async (args: { slug: string; fromRevId: string; toRevId?: string }) => {
      const dal = await initializePostgreSQL();
      const payload = await diffMediaRevisions(dal, args);
      return payload;
    })
  );

  server.registerTool(
    'page_check_create',
    {
      title: 'Create Page Check',
      description:
        'Create a new page check for a wiki page revision. checkResults and notes use language-keyed maps keyed by supported locale codes (see agpwiki://locales). metrics is required and reports issue counts.',
      annotations: additiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        type: pageCheckTypeSchema,
        status: pageCheckStatusSchema,
        checkResults: localizedCheckResultsSchema.required,
        notes: localizedNotesSchema.optional.describe(
          `${localizedNotesSchema.optional.description} ${notesDescription}`
        ),
        metrics: pageCheckMetricsSchema,
        targetRevId: uuidSchema,
        completedAt: z.string().datetime().optional().nullable(),
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.optional,
      },
    },
    withToolErrorHandling(async (args: PageCheckWriteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await createPageCheck(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'page_check_update',
    {
      title: 'Update Page Check',
      description:
        'Create a new revision for a page check. revSummary is required and uses a language-keyed map keyed by supported locale codes (see agpwiki://locales).',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        checkId: uuidSchema,
        type: pageCheckTypeSchema.optional(),
        status: pageCheckStatusSchema.optional(),
        checkResults: localizedCheckResultsSchema.optional,
        notes: localizedNotesSchema.optional.describe(
          `${localizedNotesSchema.optional.description} ${notesDescription}`
        ),
        metrics: pageCheckMetricsSchema.optional(),
        targetRevId: uuidSchema.optional(),
        completedAt: z.string().datetime().optional().nullable(),
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: PageCheckUpdateInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await updatePageCheck(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'page_check_list',
    {
      title: 'List Page Checks',
      description: 'List the current page checks for a wiki page by slug.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        slug: slugSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await listPageChecks(dal, args.slug);
      return payload;
    })
  );

  server.registerTool(
    'page_check_listRevisions',
    {
      title: 'List Page Check Revisions',
      description: 'List revisions for a page check by check ID.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        checkId: uuidSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await listPageCheckRevisions(dal, args.checkId);
      return payload;
    })
  );

  server.registerTool(
    'page_check_readRevision',
    {
      title: 'Read Page Check Revision',
      description: 'Read a specific page check revision by revision ID.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        checkId: uuidSchema,
        revId: uuidSchema,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await readPageCheckRevision(dal, args.checkId, args.revId);
      return payload;
    })
  );

  server.registerTool(
    'page_check_diffRevisions',
    {
      title: 'Diff Page Check Revisions',
      description: 'Generate a unified diff between two page check revisions.',
      annotations: readOnlyToolAnnotations,
      inputSchema: {
        checkId: uuidSchema,
        fromRevId: uuidSchema,
        toRevId: uuidSchema.optional(),
        lang: languageTagSchema.optional,
      },
    },
    withToolErrorHandling(async args => {
      const dal = await initializePostgreSQL();
      const payload = await diffPageCheckRevisions(dal, args);
      return payload;
    })
  );

  server.registerTool(
    'wiki_applyPatch',
    {
      title: 'Apply Wiki Patch',
      description:
        'Apply a patch to a wiki page body. Use format "unified" (---/+++ with @@ hunks) or "codex" (*** Begin Patch). revSummary is required, e.g., {"en":"Fix date in lead per cited archive"}. Before making edits, review policies linked from /meta/policy.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        patch: z.string(),
        format: z.enum(['unified', 'codex']),
        lang: languageTagSchema.optional,
        baseRevId: uuidSchema.optional(),
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: WikiPagePatchInput & { policyHash?: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await applyWikiPagePatch(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
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
        'Rewrite a section of a wiki page body. Use target "heading" (default) with strict case-sensitive heading matching, or target "lead" for text before the first heading. For target "heading", content applies to the section body and does not replace the heading line. revSummary is required, e.g., {"en":"Rewrite \'Legacy\' section to match sources"}. Before making edits, review policies linked from /meta/policy.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        target: z.enum(['heading', 'lead']).optional(),
        heading: z
          .string()
          .optional()
          .describe('Required when target is "heading"; omitted for target "lead".'),
        headingLevel: z.number().int().min(1).max(6).optional(),
        occurrence: z.number().int().min(1).optional(),
        mode: z.enum(['replace', 'prepend', 'append']).optional(),
        content: z.string().describe(rewriteContentDescription),
        lang: languageTagSchema.optional,
        expectedRevId: uuidSchema.optional(),
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(
      async (args: WikiPageRewriteSectionInput & { policyHash?: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await rewriteWikiPageSection(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
      }
    )
  );

  server.registerTool(
    'wiki_replaceExactText',
    {
      title: 'Replace Exact Text',
      description:
        'Replace exact case-sensitive text spans in a wiki page body. Each "from" must occur exactly once; if any "from" occurs zero or multiple times, none are applied. revSummary is required, e.g., {"en":"Fix repeated typo in lead and history section"}. Before making edits, review policies linked from /meta/policy.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        replacements: z
          .array(
            z.object({
              from: z.string().min(1),
              to: z.string(),
            })
          )
          .min(1),
        lang: languageTagSchema.optional,
        expectedRevId: uuidSchema.optional(),
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(
      async (args: WikiPageReplaceExactTextInput & { policyHash?: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await replaceWikiPageExactText(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
      }
    )
  );

  server.registerTool(
    'wiki_updatePage',
    {
      title: 'Update Wiki Page',
      description:
        'Create a new revision for an existing wiki page. Localized fields use language-keyed maps keyed by supported locale codes (see agpwiki://locales), e.g., {"en":"Title"}. revSummary is required, e.g., {"en":"Add 2022 census figures with citations"}. Before making edits, review policies linked from /meta/policy.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        newSlug: optionalSlugSchema,
        title: localizedTitleSchema.optional,
        body: localizedBodySchema.optional,
        originalLanguage: languageTagSchema.optionalNullable,
        policyHash: policyHashSchema,
        tags: z.array(z.string()).optional(),
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: WikiPageUpdateInput & { policyHash?: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await updateWikiPage(
        dal,
        { ...writeArgs, tags: mergeTags(writeArgs.tags) },
        userId
      );
      return payload;
    })
  );

  server.registerTool(
    'wiki_addAlias',
    {
      title: 'Add Wiki Page Alias',
      description: 'Create a new alias slug for an existing wiki page.',
      annotations: additiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        pageSlug: slugSchema,
        lang: languageTagSchema.optional,
        policyHash: policyHashSchema,
      },
    },
    withToolErrorHandling(async (args: WikiPageAliasInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await addWikiPageAlias(dal, writeArgs, userId);
      return payload;
    })
  );

  server.registerTool(
    'wiki_removeAlias',
    {
      title: 'Remove Wiki Page Alias',
      description: 'Remove an alias slug from a wiki page.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        policyHash: policyHashSchema,
      },
    },
    withToolErrorHandling(async (args: { slug: string; policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      await requireCurrentPolicyHash(dal, args.policyHash);
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
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: slugSchema,
        policyHash: policyHashSchema,
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: WikiPageDeleteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await deleteWikiPage(dal, { ...writeArgs }, userId);
      return payload;
    })
  );

  const citationDeleteTool = server.registerTool(
    'citation_delete',
    {
      title: 'Delete Citation',
      description:
        'Soft-delete a citation and all its revisions. Requires wiki_admin role. revSummary is required, e.g., {"en":"Delete broken URL; replaced by archived source"}.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        policyHash: policyHashSchema,
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: CitationDeleteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await deleteCitation(dal, { ...writeArgs }, userId);
      return payload;
    })
  );

  const claimDeleteTool = server.registerTool(
    'claim_delete',
    {
      title: 'Delete Citation Claim',
      description:
        'Soft-delete a citation claim and all its revisions. Requires wiki_admin role. revSummary is required.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        key: citationKeySchema,
        claimId: citationClaimIdSchema,
        policyHash: policyHashSchema,
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: CitationClaimDeleteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await deleteCitationClaim(dal, { ...writeArgs }, userId);
      return payload;
    })
  );

  const mediaDeleteTool = server.registerTool(
    'media_delete',
    {
      title: 'Delete Media',
      description:
        'Soft-delete a media entity and all its revisions. Requires wiki_admin role. Cached thumbnails are also reclaimed from disk. revSummary is required, e.g., {"en":"Delete duplicate media entry"}.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        slug: z.string(),
        policyHash: policyHashSchema,
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: MediaDeleteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await deleteMedia(
        dal,
        { ...writeArgs },
        userId,
        { storage: getMediaStorage() }
      );
      return payload;
    })
  );

  const pageCheckDeleteTool = server.registerTool(
    'page_check_delete',
    {
      title: 'Delete Page Check',
      description:
        'Soft-delete a page check and all its revisions. Requires wiki_admin role. revSummary is required, e.g., {"en":"Remove duplicate check"}.',
      annotations: destructiveWriteToolAnnotations,
      inputSchema: {
        checkId: uuidSchema,
        policyHash: policyHashSchema,
        revSummary: localizedRevisionSummarySchema.required,
      },
    },
    withToolErrorHandling(async (args: PageCheckDeleteInput & { policyHash: string }, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const { policyHash, ...writeArgs } = args;
      await requireCurrentPolicyHash(dal, policyHash);
      const payload = await deletePageCheck(dal, { ...writeArgs }, userId);
      return payload;
    })
  );

  const adminTools = {
    wikiDeletePageTool,
    citationDeleteTool,
    claimDeleteTool,
    mediaDeleteTool,
    pageCheckDeleteTool,
    blogDeleteTool,
  };

  if (!canUseWikiAdminTools(userRoles)) {
    wikiDeletePageTool.disable();
    citationDeleteTool.disable();
    claimDeleteTool.disable();
    mediaDeleteTool.disable();
    pageCheckDeleteTool.disable();
  }
  if (!canUseBlogAdminTools(userRoles)) {
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
