import './_use-database.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { generateOAuthAccessToken, getTokenMetadata } from '../src/auth/oauth.js';
import { initializePostgreSQL } from '../src/db.js';
import { authMiddleware, getAuthInfo } from '../src/mcp/http-auth.js';
import AgentAccessRequest from '../src/models/agent-access-request.js';
import OAuthAccessToken from '../src/models/oauth-access-token.js';
import OAuthClient from '../src/models/oauth-client.js';
import User from '../src/models/user.js';

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | null = null;

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const startServer = () => {
  const app = express();
  app.all('/mcp', authMiddleware, (req, res) => {
    res.json({ userId: getAuthInfo(req)?.extra?.userId });
  });
  const server = http.createServer(app);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('No address'));
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res()))),
      });
    });
  });
};

const metadataUrl = (baseUrl: string) => `${baseUrl}/.well-known/oauth-protected-resource/mcp`;

test('missing bearer token returns 401 with a resource metadata challenge', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/mcp`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      `Bearer resource_metadata="${metadataUrl(server.url)}", scope="mcp.read mcp.write"`
    );
  } finally {
    await server.close();
  }
});

test('non-bearer authorization is treated as a missing token', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    assert.equal(res.status, 401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /^Bearer resource_metadata="/);
    assert.doesNotMatch(challenge, /error=/);
  } finally {
    await server.close();
  }
});

test('invalid bearer token returns 401 with invalid_token', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${generateOAuthAccessToken()}` },
    });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      `Bearer resource_metadata="${metadataUrl(server.url)}", scope="mcp.read mcp.write", error="invalid_token"`
    );
    assert.deepEqual(await res.json(), { error: 'Invalid or expired token.' });
  } finally {
    await server.close();
  }
});

test('valid bearer token reaches the handler without a challenge', async () => {
  sharedDal = await initializePostgreSQL();
  const suffix = randomBytes(6).toString('hex');
  const user = await User.create({
    username: `mcpauth${suffix}`,
    displayName: 'MCP Auth Test',
    email: `mcp-auth-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: new Date(),
    emailVerifiedAt: new Date(),
  });
  await AgentAccessRequest.create({
    userId: user.id,
    interests: 'MCP auth testing',
    profileUrl: 'https://example.com/profile',
    status: 'approved',
    createdAt: new Date(),
    submittedAt: new Date(),
    reviewedAt: new Date(),
    approvedAt: new Date(),
  });
  const clientId = `mcp-auth-client-${suffix}`;
  await OAuthClient.create({
    clientId,
    clientName: 'MCP Auth Test Client',
    redirectUris: ['https://example.com/callback'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
    createdAt: new Date(),
  });
  const token = generateOAuthAccessToken();
  await OAuthAccessToken.create({
    ...getTokenMetadata(token),
    clientId,
    userId: user.id,
    scopes: ['mcp.read', 'mcp.write'],
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const server = await startServer();
  try {
    const res = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('www-authenticate'), null);
    assert.deepEqual(await res.json(), { userId: user.id });
  } finally {
    await server.close();
  }
});
