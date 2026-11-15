import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { generateOAuthAccessToken, generateOAuthRefreshToken, getTokenMetadata } from '../src/auth/oauth.js';
import { initializePostgreSQL } from '../src/db.js';
import { resolveAuthInfoFromToken } from '../src/mcp/auth.js';
import AgentAccessRequest from '../src/models/agent-access-request.js';
import OAuthAccessToken from '../src/models/oauth-access-token.js';
import OAuthClient from '../src/models/oauth-client.js';
import OAuthRefreshToken from '../src/models/oauth-refresh-token.js';
import User from '../src/models/user.js';
import { registerOAuthRoutes } from '../src/routes/oauth.js';

let sharedDal: Awaited<ReturnType<typeof initializePostgreSQL>> | null = null;

const getDal = async () => {
  if (sharedDal) return sharedDal;
  sharedDal = await initializePostgreSQL();
  return sharedDal;
};

test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const makeTestServer = () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  // stub req.t so OAuth error paths don't throw
  app.use((req, _res, next) => {
    (req as express.Request & { t: (k: string) => string }).t = (k: string) => k;
    next();
  });
  registerOAuthRoutes(app);
  const server = http.createServer(app);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('No address'));
      const url = `http://127.0.0.1:${addr.port}`;
      const close = () => new Promise<void>((res, rej) => server.close(e => e ? rej(e) : res()));
      resolve({ url, close });
    });
  });
};

const cleanupOAuthArtifacts = async (
  dal: Awaited<ReturnType<typeof initializePostgreSQL>>,
  {
    userId,
    clientId,
  }: { userId?: string; clientId?: string }
) => {
  if (clientId) {
    await dal.query('DELETE FROM oauth_access_tokens WHERE client_id = $1', [clientId]);
    await dal.query('DELETE FROM oauth_refresh_tokens WHERE client_id = $1', [clientId]);
    await dal.query('DELETE FROM oauth_authorization_codes WHERE client_id = $1', [clientId]);
    await dal.query('DELETE FROM oauth_clients WHERE client_id = $1', [clientId]);
  }
  if (userId) {
    await dal.query('DELETE FROM users WHERE id = $1', [userId]);
  }
};

test('OAuth access token resolves to MCP auth info', async () => {
  const dal = await getDal();
  let userId: string | null = null;
  const clientId = `test-client-${Date.now()}`;

  try {
    const user = await User.create({
      username: `oauthtest${Date.now()}`,
      displayName: 'OAuth Test',
      email: `oauth-test-${Date.now()}@example.com`,
      passwordHash: randomBytes(32).toString('hex'),
      createdAt: new Date(),
      emailVerifiedAt: new Date(),
    });
    userId = user.id;

    await AgentAccessRequest.create({
      userId: user.id,
      interests: 'OAuth testing',
      profileUrl: 'https://example.com/profile',
      status: 'approved',
      createdAt: new Date(),
      submittedAt: new Date(),
      reviewedAt: new Date(),
      approvedAt: new Date(),
    });

    await OAuthClient.create({
      clientId,
      clientName: 'OAuth Test Client',
      redirectUris: ['https://example.com/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date(),
    });

    const token = generateOAuthAccessToken();
    const tokenMeta = getTokenMetadata(token);

    await OAuthAccessToken.create({
      ...tokenMeta,
      clientId,
      userId: user.id,
      scopes: ['mcp.read', 'mcp.write'],
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const authInfo = await resolveAuthInfoFromToken(token);
    assert.equal(authInfo.extra?.userId, user.id);
    assert.equal(authInfo.extra?.oauthClientId, clientId);
  } finally {
    try {
      await cleanupOAuthArtifacts(dal, { userId: userId ?? undefined, clientId });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});

test('refresh token rotation: new tokens issued before old token is consumed', async () => {
  const dal = await getDal();
  let userId: string | null = null;
  const clientId = `test-refresh-client-${Date.now()}`;
  const server = await makeTestServer();

  try {
    const user = await User.create({
      username: `refreshtest${Date.now()}`,
      displayName: 'Refresh Test',
      email: `refresh-test-${Date.now()}@example.com`,
      passwordHash: randomBytes(32).toString('hex'),
      createdAt: new Date(),
    });
    userId = user.id;

    await OAuthClient.create({
      clientId,
      clientName: 'Refresh Test Client',
      redirectUris: ['https://example.com/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date(),
    });

    const refreshToken = generateOAuthRefreshToken();
    const refreshMeta = getTokenMetadata(refreshToken);
    await OAuthRefreshToken.create({
      ...refreshMeta,
      clientId,
      userId: user.id,
      scopes: ['mcp.read', 'mcp.write'],
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });

    // Use the refresh token
    const res = await fetch(`${server.url}/tool/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(body.access_token, 'response includes access_token');
    assert.ok(body.refresh_token, 'response includes refresh_token');
    assert.notEqual(body.refresh_token, refreshToken, 'new refresh token differs from old');

    // Old token must be rotated in the DB
    const consumed = await OAuthRefreshToken.filterWhere({ tokenHash: refreshMeta.tokenHash }).first();
    assert.ok(consumed?.rotatedAt, 'old refresh token has rotated_at set');

    // Old token must be rejected on a second attempt
    const retry = await fetch(`${server.url}/tool/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    });
    assert.equal(retry.status, 400);
    const retryBody = await retry.json() as Record<string, unknown>;
    assert.equal(retryBody.error, 'invalid_grant');
  } finally {
    await server.close();
    try {
      await cleanupOAuthArtifacts(dal, { userId: userId ?? undefined, clientId });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.warn(`Cleanup failed: ${message}`);
    }
  }
});
