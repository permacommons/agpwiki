import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpServer } from './core.js';
import { registerWebFetchTool } from './web-tool.js';

const transport = new StdioServerTransport();

const { server, formatToolResult, formatToolErrorResult } = createMcpServer();
registerWebFetchTool(server, formatToolResult, formatToolErrorResult);

await server.connect(transport);
