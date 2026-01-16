import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpServer } from './core.js';

const transport = new StdioServerTransport();

const { server } = createMcpServer();

await server.connect(transport);
