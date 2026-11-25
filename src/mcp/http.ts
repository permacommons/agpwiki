import { randomUUID } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import config from 'config';
import type { NextFunction, Request, Response } from 'express';

import debug from '../../util/debug.js';
import { initializePostgreSQL } from '../db.js';
import { getUserRoles } from '../services/roles.js';
import { createMcpServer } from './core.js';
import { authMiddleware, getAuthInfo, sendInvalidToken } from './http-auth.js';
import { isJsonParseError } from './http-errors.js';

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

const mcpConfig = getMcpConfig();
const host = mcpConfig.host ?? '127.0.0.1';
const port = mcpConfig.port ?? 3333;

const app = createMcpExpressApp({
  host,
  allowedHosts: mcpConfig.allowedHosts,
});
// The WWW-Authenticate challenge is built from req.protocol, which is only
// correct behind a TLS-terminating proxy if the proxy is trusted.
app.set('trust proxy', config.get<boolean | string | number | string[]>('server.trustProxy'));

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>['server'];
  userId: string;
  lastUsedAt: number;
};

const sessions = new Map<string, SessionEntry>();

const sendJsonError = (res: Response, status: number, message: string) => {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
};

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (isJsonParseError(error)) {
    if (!res.headersSent) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid request: malformed JSON.' },
        id: null,
      });
    }
    return;
  }
  next(error);
});

app.all('/mcp', authMiddleware, async (req, res) => {
  const authInfo = getAuthInfo(req);
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== 'string' || !userId) {
    sendInvalidToken(req, res, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized.' },
      id: null,
    });
    return;
  }

  const sessionIdHeader = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
  const entry = sessionId ? sessions.get(sessionId) : undefined;
  let transport: StreamableHTTPServerTransport | null = null;
  let server: ReturnType<typeof createMcpServer>['server'] | null = null;

  if (entry) {
    if (entry.userId !== userId) {
      sendJsonError(res, 403, 'Forbidden: session does not match token user.');
      return;
    }
    entry.lastUsedAt = Date.now();
    transport = entry.transport;
    server = entry.server;
  } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
    const dal = await initializePostgreSQL();
    const userRoles = await getUserRoles(dal, userId);
    const mcp = createMcpServer({ userRoles });
    server = mcp.server;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: initializedId => {
        sessions.set(initializedId, {
          transport: transport as StreamableHTTPServerTransport,
          server: server as ReturnType<typeof createMcpServer>['server'],
          userId,
          lastUsedAt: Date.now(),
        });
      },
      onsessionclosed: closedId => {
        sessions.delete(closedId);
      },
    });

    transport.onclose = () => {
      if (transport?.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
  } else {
    sendJsonError(res, 404, 'Session not found or expired.');
    return;
  }

  try {
    await transport.handleRequest(req, res, req.body);
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
