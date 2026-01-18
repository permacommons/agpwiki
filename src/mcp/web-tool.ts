import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { FormatToolResult } from './core.js';
import { McpToolError } from './errors.js';
import { fetchWebPage } from './web.js';

export const registerWebFetchTool = (
  server: McpServer,
  formatToolResult: FormatToolResult,
  formatToolErrorResult: (error: unknown) => CallToolResult
) => {
  server.registerTool(
    'web.fetch',
    {
      title: 'Fetch Web Page',
      description: 'Fetch a web page via Playwright and return its text content and metadata.',
      inputSchema: {
        url: z.string().url(),
        waitMs: z.number().int().nonnegative().optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxChars: z.number().int().positive().optional(),
        includeHtml: z.boolean().optional(),
        headless: z.boolean().optional(),
        slowMoMs: z.number().int().nonnegative().optional(),
        holdOpenMs: z.number().int().nonnegative().optional(),
      },
    },
    async args => {
      try {
        const payload = await fetchWebPage(args);
        return formatToolResult(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return formatToolErrorResult(
          new McpToolError('internal_error', message, {
            details: {
              hint:
                'If Playwright fails to launch, install system deps with: sudo npx playwright install-deps',
            },
          })
        );
      }
    }
  );
};
