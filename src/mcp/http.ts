import config from 'config';
import type { NextFunction, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import debug from '../../util/debug.js';
import { initializePostgreSQL } from '../db.js';
import { verifyAuthToken } from './auth.js';
import { createMcpServer } from './core.js';

type McpConfig = {
  host?: string;
  port?: number;
  allowedHosts?: string[];
};

const getMcpConfig = (): McpConfig => {
  if (typeof config.has === 'function' && config.has('mcp')) {
    return config.get<McpConfig>('mcp');
  }
  return {};
};

const parseBearerToken = (req: Request) => {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  return value?.trim() || null;
};

const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = parseBearerToken(req);
    if (!token) {
      res.status(401).json({
        error: 'Missing Authorization header. Use: Authorization: Bearer <token>',
      });
      return;
    }

    await initializePostgreSQL();
    const record = await verifyAuthToken(token);

    const authInfo: AuthInfo = {
      token,
      clientId: record.userId,
      scopes: [],
      extra: {
        userId: record.userId,
        tokenId: record.id,
        tokenPrefix: record.tokenPrefix,
        tokenLast4: record.tokenLast4 ?? null,
        label: record.label ?? null,
      },
    };

    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    next();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`MCP auth failed: ${message}`);
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

const mcpConfig = getMcpConfig();
const host = mcpConfig.host ?? '127.0.0.1';
const port = mcpConfig.port ?? 3333;

const app = createMcpExpressApp({
  host,
  allowedHosts: mcpConfig.allowedHosts,
});

app.all('/mcp', authMiddleware, async (req, res) => {
  const { server } = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`MCP HTTP request failed: ${message}`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.listen(port, host, error => {
  if (error) {
    debug.error(`Failed to start MCP HTTP server: ${String(error)}`);
    process.exit(1);
  }
  debug.app(`MCP HTTP server listening on ${host}:${port}`);
});
