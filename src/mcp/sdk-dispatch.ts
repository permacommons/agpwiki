import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  McpError,
  ReadResourceRequestSchema,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { InvalidRequestError, UnsupportedError } from '../lib/errors.js';
import { toValidationErrorFromZod } from './errors.js';

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

// Private SDK registries are needed to preserve structured tool errors and
// resource guidance while honoring live registration and enable/disable changes.
export const installSdkRequestHandlers = (
  server: McpServer,
  formatToolErrorResult: (error: unknown) => CallToolResult
) => {
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

    const mcpServer = server as unknown as {
      _registeredResources: Record<string, RegisteredResource>;
      _registeredResourceTemplates: Record<string, RegisteredTemplate>;
    };

    const resource = mcpServer._registeredResources[uri.toString()];
    if (resource) {
      if (!resource.enabled) {
        throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} disabled`);
      }
      return resource.readCallback(uri, extra);
    }

    for (const template of Object.values(mcpServer._registeredResourceTemplates)) {
      const variables = template.resourceTemplate.uriTemplate.match(uri.toString());
      if (variables) {
        return template.readCallback(uri, variables, extra);
      }
    }

    throw new McpError(
      ErrorCode.InvalidParams,
      `Resource not found: ${uri}. Available resources: agpwiki://pages, agpwiki://blog/posts, agpwiki://locales. To read individual items, use tools: wiki_readPage, blog_readPost, citation_read.`
    );
  });
};
