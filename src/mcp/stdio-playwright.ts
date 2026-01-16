import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpServer } from './core.js';
import { registerWebFetchTool } from './web-tool.js';

const transport = new StdioServerTransport();

const { server, formatToolResult } = createMcpServer();
registerWebFetchTool(server, formatToolResult);

await server.connect(transport);
