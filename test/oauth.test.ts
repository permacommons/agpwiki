import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { generateOAuthAccessToken, getTokenMetadata } from '../src/auth/oauth.js';
import { initializePostgreSQL } from '../src/db.js';
import { resolveAuthInfoFromToken } from '../src/mcp/auth.js';
import OAuthAccessToken from '../src/models/oauth-access-token.js';
import OAuthClient from '../src/models/oauth-client.js';
import User from '../src/models/user.js';

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
      displayName: 'OAuth Test',
      email: `oauth-test-${Date.now()}@example.com`,
      passwordHash: randomBytes(32).toString('hex'),
      createdAt: new Date(),
    });
    userId = user.id;

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
