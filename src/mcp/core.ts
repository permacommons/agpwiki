import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { initializePostgreSQL } from '../db.js';
import { resolveAuthUserId } from './auth.js';
import {
  createBlogPost,
  diffBlogPostRevisions,
  listBlogPostResources,
  listBlogPostRevisions,
  readBlogPost,
  readBlogPostResource,
  readBlogPostRevision,
  updateBlogPost,
} from './blog-handlers.js';
import {
  addWikiPageAlias,
  applyWikiPagePatch,
  createCitation,
  createWikiPage,
  diffCitationRevisions,
  diffWikiPageRevisions,
  listCitationRevisions,
  listWikiPageResources,
  listWikiPageRevisions,
  queryCitations,
  readCitation,
  readCitationResource,
  readCitationRevision,
  readWikiPage,
  readWikiPageResource,
  readWikiPageRevision,
  removeWikiPageAlias,
  updateCitation,
  updateWikiPage,
} from './handlers.js';

export type FormatToolResult = (payload: unknown) => CallToolResult;

export const createMcpServer = () => {
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

  const wikiPageTemplate = new ResourceTemplate('agpwiki://page{?slug}', {
    list: undefined,
  });

  server.registerResource(
    'Wiki Page',
    wikiPageTemplate,
    {
      title: 'Wiki Page',
      description: 'Read a single wiki page by slug.',
      mimeType: 'application/json',
    },
    async uri => {
      const dal = await initializePostgreSQL();
      const result = await readWikiPageResource(dal, uri.toString());
      return result as ReadResourceResult;
    }
  );

  const blogPostTemplate = new ResourceTemplate('agpwiki://blog{?slug}', {
    list: undefined,
  });

  server.registerResource(
    'Blog Post',
    blogPostTemplate,
    {
      title: 'Blog Post',
      description: 'Read a single blog post by slug.',
      mimeType: 'application/json',
    },
    async uri => {
      const dal = await initializePostgreSQL();
      const result = await readBlogPostResource(dal, uri.toString());
      return result as ReadResourceResult;
    }
  );

  server.registerResource(
    'Blog Post Revisions',
    new ResourceTemplate('agpwiki://blog/revisions{?slug}', {
      list: undefined,
    }),
    {
      title: 'Blog Post Revisions',
      description: 'List revisions for a blog post.',
      mimeType: 'application/json',
    },
    async uri => {
      const slug = uri.searchParams.get('slug');
      if (!slug) {
        throw new Error('Missing slug for blog post revisions.');
      }
      const dal = await initializePostgreSQL();
      const payload = await listBlogPostRevisions(dal, slug);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      } satisfies ReadResourceResult;
    }
  );

  server.registerResource(
    'Blog Post Revision',
    new ResourceTemplate('agpwiki://blog/revision{?slug,revId}', {
      list: undefined,
    }),
    {
      title: 'Blog Post Revision',
      description: 'Read a specific blog post revision by revision ID.',
      mimeType: 'application/json',
    },
    async uri => {
      const slug = uri.searchParams.get('slug');
      const revId = uri.searchParams.get('revId');
      if (!slug || !revId) {
        throw new Error('Missing slug or revId for blog post revision.');
      }
      const dal = await initializePostgreSQL();
      const payload = await readBlogPostRevision(dal, slug, revId);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      } satisfies ReadResourceResult;
    }
  );

  server.registerResource(
    'Wiki Page Revisions',
    new ResourceTemplate('agpwiki://page/revisions{?slug}', {
      list: undefined,
    }),
    {
      title: 'Wiki Page Revisions',
      description: 'List revisions for a wiki page.',
      mimeType: 'application/json',
    },
    async uri => {
      const slug = uri.searchParams.get('slug');
      if (!slug) {
        throw new Error('Missing slug for wiki page revisions.');
      }
      const dal = await initializePostgreSQL();
      const payload = await listWikiPageRevisions(dal, slug);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      } satisfies ReadResourceResult;
    }
  );

  server.registerResource(
    'Wiki Page Revision',
    new ResourceTemplate('agpwiki://page/revision{?slug,revId}', {
      list: undefined,
    }),
    {
      title: 'Wiki Page Revision',
      description: 'Read a specific wiki page revision by revision ID.',
      mimeType: 'application/json',
    },
    async uri => {
      const slug = uri.searchParams.get('slug');
      const revId = uri.searchParams.get('revId');
      if (!slug || !revId) {
        throw new Error('Missing slug or revId for wiki page revision.');
      }
      const dal = await initializePostgreSQL();
      const payload = await readWikiPageRevision(dal, slug, revId);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      } satisfies ReadResourceResult;
    }
  );

  server.registerResource(
    'Citation',
    new ResourceTemplate('agpwiki://citation{?key}', {
      list: undefined,
    }),
    {
      title: 'Citation',
      description: 'Read a citation by key.',
      mimeType: 'application/json',
    },
    async uri => {
      const dal = await initializePostgreSQL();
      const result = await readCitationResource(dal, uri.toString());
      return result as ReadResourceResult;
    }
  );

  server.registerResource(
    'Citation Revisions',
    new ResourceTemplate('agpwiki://citation/revisions{?key}', {
      list: undefined,
    }),
    {
      title: 'Citation Revisions',
      description: 'List revisions for a citation.',
      mimeType: 'application/json',
    },
    async uri => {
      const key = uri.searchParams.get('key');
      if (!key) {
        throw new Error('Missing key for citation revisions.');
      }
      const dal = await initializePostgreSQL();
      const payload = await listCitationRevisions(dal, key);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      } satisfies ReadResourceResult;
    }
  );

  server.registerResource(
    'Citation Revision',
    new ResourceTemplate('agpwiki://citation/revision{?key,revId}', {
      list: undefined,
    }),
    {
      title: 'Citation Revision',
      description: 'Read a specific citation revision by revision ID.',
      mimeType: 'application/json',
    },
    async uri => {
      const key = uri.searchParams.get('key');
      const revId = uri.searchParams.get('revId');
      if (!key || !revId) {
        throw new Error('Missing key or revId for citation revision.');
      }
      const dal = await initializePostgreSQL();
      const payload = await readCitationRevision(dal, key, revId);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      } satisfies ReadResourceResult;
    }
  );

  server.registerTool(
    'wiki_createPage',
    {
      title: 'Create Wiki Page',
      description: 'Create a new wiki page with initial content.',
      inputSchema: {
        slug: z.string(),
        title: z.record(z.string(), z.string()).nullable().optional(),
        body: z.record(z.string(), z.string()).nullable().optional(),
        originalLanguage: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        revSummary: z.record(z.string(), z.string()).nullable().optional(),
      },
    },
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await createWikiPage(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'citation_create',
    {
      title: 'Create Citation',
      description: 'Create a new citation entry with CSL JSON data.',
      inputSchema: {
        key: z.string(),
        data: z.record(z.string(), z.unknown()),
        tags: z.array(z.string()).optional(),
        revSummary: z.record(z.string(), z.string()).nullable().optional(),
      },
    },
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await createCitation(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return formatToolResult(payload);
    }
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
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await queryCitations(dal, args);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'blog_createPost',
    {
      title: 'Create Blog Post',
      description: 'Create a new blog post with initial content.',
      inputSchema: {
        slug: z.string(),
        title: z.record(z.string(), z.string()).nullable().optional(),
        body: z.record(z.string(), z.string()).nullable().optional(),
        summary: z.record(z.string(), z.string()).nullable().optional(),
        originalLanguage: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        revSummary: z.record(z.string(), z.string()).nullable().optional(),
      },
    },
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await createBlogPost(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'blog_updatePost',
    {
      title: 'Update Blog Post',
      description: 'Create a new revision for an existing blog post.',
      inputSchema: {
        slug: z.string(),
        newSlug: z.string().optional(),
        title: z.record(z.string(), z.string()).nullable().optional(),
        body: z.record(z.string(), z.string()).nullable().optional(),
        summary: z.record(z.string(), z.string()).nullable().optional(),
        originalLanguage: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        revSummary: z.record(z.string(), z.string()),
      },
    },
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await updateBlogPost(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return formatToolResult(payload);
    }
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
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await listBlogPostRevisions(dal, args.slug);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'blog_diffRevisions',
    {
      title: 'Diff Blog Post Revisions',
      description: 'Generate a unified diff between two blog post revisions.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
        fromRevId: z.string(),
        toRevId: z.string().optional(),
        lang: z.string().optional(),
      },
    },
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await diffBlogPostRevisions(dal, args);
      return formatToolResult(payload);
    }
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
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await readBlogPost(dal, args.slug);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'blog_readRevision',
    {
      title: 'Read Blog Post Revision',
      description: 'Read a specific blog post revision by revision ID.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
        revId: z.string(),
      },
    },
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await readBlogPostRevision(dal, args.slug, args.revId);
      return formatToolResult(payload);
    }
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
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await listCitationRevisions(dal, args.key);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'citation_diffRevisions',
    {
      title: 'Diff Citation Revisions',
      description: 'Generate a unified diff between two citation revisions.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        key: z.string(),
        fromRevId: z.string(),
        toRevId: z.string().optional(),
      },
    },
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await diffCitationRevisions(dal, args);
      return formatToolResult(payload);
    }
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
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await readCitation(dal, args.key);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'citation_readRevision',
    {
      title: 'Read Citation Revision',
      description: 'Read a specific citation revision by revision ID.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        key: z.string(),
        revId: z.string(),
      },
    },
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await readCitationRevision(dal, args.key, args.revId);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'citation_update',
    {
      title: 'Update Citation',
      description: 'Create a new revision for an existing citation.',
      inputSchema: {
        key: z.string(),
        newKey: z.string().optional(),
        data: z.record(z.string(), z.unknown()).nullable().optional(),
        tags: z.array(z.string()).optional(),
        revSummary: z.record(z.string(), z.string()),
      },
    },
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await updateCitation(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return formatToolResult(payload);
    }
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
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await listWikiPageRevisions(dal, args.slug);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'wiki_diffRevisions',
    {
      title: 'Diff Wiki Page Revisions',
      description: 'Generate a unified diff between two revisions.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
        fromRevId: z.string(),
        toRevId: z.string().optional(),
        lang: z.string().optional(),
      },
    },
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await diffWikiPageRevisions(dal, args);
      return formatToolResult(payload);
    }
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
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await readWikiPage(dal, args.slug);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'wiki_readRevision',
    {
      title: 'Read Wiki Page Revision',
      description: 'Read a specific wiki page revision by revision ID.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        slug: z.string(),
        revId: z.string(),
      },
    },
    async args => {
      const dal = await initializePostgreSQL();
      const payload = await readWikiPageRevision(dal, args.slug, args.revId);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'wiki_applyPatch',
    {
      title: 'Apply Wiki Patch',
      description:
        'Apply a patch to a wiki page body. Use format "unified" (---/+++ with @@ hunks) or "codex" (*** Begin Patch).',
      inputSchema: {
        slug: z.string(),
        patch: z.string(),
        format: z.enum(['unified', 'codex']),
        lang: z.string().optional(),
        baseRevId: z.string().optional(),
        tags: z.array(z.string()).optional(),
        revSummary: z.record(z.string(), z.string()),
      },
    },
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await applyWikiPagePatch(
        dal,
        { ...args, tags: mergeTags(args.tags) },
        userId
      );
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'wiki_updatePage',
    {
      title: 'Update Wiki Page',
      description: 'Create a new revision for an existing wiki page.',
      inputSchema: {
        slug: z.string(),
        newSlug: z.string().optional(),
        title: z.record(z.string(), z.string()).nullable().optional(),
        body: z.record(z.string(), z.string()).nullable().optional(),
        originalLanguage: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        revSummary: z.record(z.string(), z.string()),
      },
    },
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await updateWikiPage(dal, { ...args, tags: mergeTags(args.tags) }, userId);
      return formatToolResult(payload);
    }
  );

  server.registerTool(
    'wiki_addAlias',
    {
      title: 'Add Wiki Page Alias',
      description: 'Create a new alias slug for an existing wiki page.',
      inputSchema: {
        slug: z.string(),
        pageSlug: z.string(),
        lang: z.string().optional(),
      },
    },
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await addWikiPageAlias(dal, args, userId);
      return formatToolResult(payload);
    }
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
    async (args, extra) => {
      const dal = await initializePostgreSQL();
      const userId = await requireAuthUserId(extra);
      const payload = await removeWikiPageAlias(dal, args.slug, userId);
      return formatToolResult(payload);
    }
  );

  return { server, formatToolResult };
};
