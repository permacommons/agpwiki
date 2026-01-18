import type { Express, Request, Response } from 'express';

import {
  formatScope,
  generateOAuthAccessToken,
  generateOAuthClientId,
  generateOAuthClientSecret,
  generateOAuthCode,
  generateOAuthRefreshToken,
  getOAuthConfig,
  getTokenMetadata,
  parseScopeParam,
  resolveScopes,
  verifyPkceChallenge,
} from '../auth/oauth.js';
import { resolveSessionUser } from '../auth/session.js';
import { hashToken } from '../auth/tokens.js';
import { initializePostgreSQL } from '../db.js';
import OAuthAccessToken from '../models/oauth-access-token.js';
import OAuthAuthorizationCode from '../models/oauth-authorization-code.js';
import OAuthClient from '../models/oauth-client.js';
import OAuthRefreshToken from '../models/oauth-refresh-token.js';
import { escapeHtml, renderLayout } from '../render.js';

const renderOAuthLayout = (title: string, bodyHtml: string, signedIn = false) =>
  renderLayout({
    title,
    labelHtml: '<div class="page-label">TOOL — BUILT-IN SOFTWARE FEATURE</div>',
    bodyHtml,
    signedIn,
  });

const renderOAuthError = (res: Response, message: string, signedIn = false) => {
  const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p class="form-error">${escapeHtml(message)}</p>
  </div>
</div>`;
  res.status(400).type('html').send(renderOAuthLayout('OAuth error', bodyHtml, signedIn));
};

const pickString = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
};

const parseAuthHeader = (req: Request) => {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, credentials] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !credentials) return null;
  const decoded = Buffer.from(credentials, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  const clientId = decoded.slice(0, separator);
  const clientSecret = decoded.slice(separator + 1);
  return { clientId, clientSecret };
};

const sendTokenError = (res: Response, status: number, error: string, description?: string) => {
  res.status(status).json({
    error,
    error_description: description,
  });
};

const redirectWithParams = (
  res: Response,
  redirectUri: string,
  params: Record<string, string | undefined>
) => {
  try {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }
    res.redirect(302, url.toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderOAuthError(res, `Invalid redirect URI: ${message}`);
  }
};

const requireOAuthClient = async (clientId: string) => {
  const client = await OAuthClient.findActiveByClientId(clientId);
  if (!client) return null;
  return client;
};

const isValidRedirectUri = (client: { redirectUris: string[] }, redirectUri: string) =>
  client.redirectUris.includes(redirectUri);

const isValidAuthMethod = (method: string) =>
  method === 'none' || method === 'client_secret_post' || method === 'client_secret_basic';

const getRequestBodyValue = (req: Request, key: string) => pickString(req.body?.[key]);

export const registerOAuthRoutes = (app: Express) => {
  app.get('/tool/oauth/authorize', async (req, res) => {
    const responseType = pickString(req.query.response_type);
    const clientId = pickString(req.query.client_id);
    const redirectUri = pickString(req.query.redirect_uri);
    const scopeParam = pickString(req.query.scope);
    const state = pickString(req.query.state);
    const codeChallenge = pickString(req.query.code_challenge);
    const codeChallengeMethod = pickString(req.query.code_challenge_method) ?? 'S256';

    if (responseType !== 'code') {
      renderOAuthError(res, 'Invalid response type.');
      return;
    }

    if (!clientId || !redirectUri || !codeChallenge) {
      renderOAuthError(res, 'Missing required OAuth parameters.');
      return;
    }

    await initializePostgreSQL();
    const client = await requireOAuthClient(clientId);
    if (!client) {
      renderOAuthError(res, 'Unknown OAuth client.');
      return;
    }

    if (!isValidRedirectUri(client, redirectUri)) {
      renderOAuthError(res, 'Redirect URI is not registered for this client.');
      return;
    }

    if (!['S256', 'plain'].includes(codeChallengeMethod)) {
      redirectWithParams(res, redirectUri, {
        error: 'invalid_request',
        error_description: 'Unsupported code challenge method.',
        state,
      });
      return;
    }

    const session = await resolveSessionUser(req);
    if (!session) {
      const loginUrl = `/tool/auth/login?redirect=${encodeURIComponent(req.originalUrl)}`;
      res.redirect(302, loginUrl);
      return;
    }

    const requestedScopes = resolveScopes(parseScopeParam(scopeParam));
    const scopeList = requestedScopes.length
      ? `<ul class="form-help">${requestedScopes
          .map(scope => `<li>${escapeHtml(scope)}</li>`)
          .join('')}</ul>`
      : '<p class="form-help">No scopes requested.</p>';

    const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    <h2>Authorize access</h2>
    <p class="form-help">${escapeHtml(client.clientName ?? client.clientId)} is requesting access.</p>
    ${scopeList}
    <input type="hidden" name="response_type" value="${escapeHtml(responseType)}" />
    <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
    <input type="hidden" name="scope" value="${escapeHtml(formatScope(requestedScopes))}" />
    <input type="hidden" name="state" value="${escapeHtml(state ?? '')}" />
    <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}" />
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}" />
    <div class="form-actions">
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </div>
  </form>
</div>`;

    res.type('html').send(renderOAuthLayout('Authorize', bodyHtml, true));
  });

  app.post('/tool/oauth/authorize', async (req, res) => {
    const responseType = getRequestBodyValue(req, 'response_type');
    const clientId = getRequestBodyValue(req, 'client_id');
    const redirectUri = getRequestBodyValue(req, 'redirect_uri');
    const scopeParam = getRequestBodyValue(req, 'scope');
    const state = getRequestBodyValue(req, 'state');
    const codeChallenge = getRequestBodyValue(req, 'code_challenge');
    const codeChallengeMethod = getRequestBodyValue(req, 'code_challenge_method') ?? 'S256';
    const decision = getRequestBodyValue(req, 'decision');

    if (responseType !== 'code' || !clientId || !redirectUri || !codeChallenge) {
      renderOAuthError(res, 'Missing required OAuth parameters.', true);
      return;
    }

    await initializePostgreSQL();
    const client = await requireOAuthClient(clientId);
    if (!client) {
      renderOAuthError(res, 'Unknown OAuth client.', true);
      return;
    }

    if (!isValidRedirectUri(client, redirectUri)) {
      renderOAuthError(res, 'Redirect URI is not registered for this client.', true);
      return;
    }

    const session = await resolveSessionUser(req);
    if (!session) {
      const loginUrl = `/tool/auth/login?redirect=${encodeURIComponent(req.originalUrl)}`;
      res.redirect(302, loginUrl);
      return;
    }

    if (decision !== 'approve') {
      redirectWithParams(res, redirectUri, {
        error: 'access_denied',
        state,
      });
      return;
    }

    if (!['S256', 'plain'].includes(codeChallengeMethod)) {
      redirectWithParams(res, redirectUri, {
        error: 'invalid_request',
        error_description: 'Unsupported code challenge method.',
        state,
      });
      return;
    }

    const { authorizationCodeTtlSeconds } = getOAuthConfig();
    const code = generateOAuthCode();
    const codeHash = hashToken(code);
    const codePrefix = code.slice(0, 8);
    const expiresAt = new Date(Date.now() + authorizationCodeTtlSeconds * 1000);
    const scopes = resolveScopes(parseScopeParam(scopeParam));

    await OAuthAuthorizationCode.create({
      codeHash,
      codePrefix,
      clientId,
      userId: session.userId,
      redirectUri,
      scopes,
      codeChallenge,
      codeChallengeMethod,
      expiresAt,
      createdAt: new Date(),
    });

    redirectWithParams(res, redirectUri, { code, state });
  });

  app.post('/tool/oauth/token', async (req, res) => {
    const grantType = getRequestBodyValue(req, 'grant_type');
    if (!grantType) {
      sendTokenError(res, 400, 'invalid_request', 'Missing grant_type.');
      return;
    }

    await initializePostgreSQL();

    const headerAuth = parseAuthHeader(req);
    const clientId = headerAuth?.clientId ?? getRequestBodyValue(req, 'client_id');
    const clientSecret = headerAuth?.clientSecret ?? getRequestBodyValue(req, 'client_secret');

    if (!clientId) {
      sendTokenError(res, 401, 'invalid_client', 'Missing client_id.');
      return;
    }

    const client = await requireOAuthClient(clientId);
    if (!client) {
      sendTokenError(res, 401, 'invalid_client', 'Unknown client.');
      return;
    }

    if (!isValidAuthMethod(client.tokenEndpointAuthMethod)) {
      sendTokenError(res, 401, 'invalid_client', 'Unsupported client auth method.');
      return;
    }

    if (!client.grantTypes.includes(grantType)) {
      sendTokenError(res, 400, 'unauthorized_client', 'Client is not allowed this grant type.');
      return;
    }

    if (client.tokenEndpointAuthMethod === 'none') {
      if (client.clientSecretHash) {
        sendTokenError(res, 401, 'invalid_client', 'Client requires authentication.');
        return;
      }
    } else {
      if (!clientSecret) {
        sendTokenError(res, 401, 'invalid_client', 'Missing client_secret.');
        return;
      }
      const secretHash = hashToken(clientSecret);
      if (secretHash !== client.clientSecretHash) {
        sendTokenError(res, 401, 'invalid_client', 'Invalid client_secret.');
        return;
      }
    }

    if (grantType === 'authorization_code') {
      const code = getRequestBodyValue(req, 'code');
      const redirectUri = getRequestBodyValue(req, 'redirect_uri');
      const codeVerifier = getRequestBodyValue(req, 'code_verifier');

      if (!code || !redirectUri || !codeVerifier) {
        sendTokenError(res, 400, 'invalid_request', 'Missing authorization_code parameters.');
        return;
      }

      const codeHash = hashToken(code);
      const authCode = await OAuthAuthorizationCode.findActiveByHash(codeHash);
      if (!authCode) {
        sendTokenError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired.');
        return;
      }

      if (authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
        sendTokenError(res, 400, 'invalid_grant', 'Authorization code mismatch.');
        return;
      }

      if (!verifyPkceChallenge(codeVerifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
        sendTokenError(res, 400, 'invalid_grant', 'PKCE verification failed.');
        return;
      }

      authCode.consumedAt = new Date();
      await authCode.save();

      const {
        accessTokenTtlSeconds,
        refreshTokenTtlSeconds,
      } = getOAuthConfig();
      const accessToken = generateOAuthAccessToken();
      const refreshToken = generateOAuthRefreshToken();

      const accessMeta = getTokenMetadata(accessToken);
      const refreshMeta = getTokenMetadata(refreshToken);

      const now = new Date();
      const accessExpiresAt = new Date(now.getTime() + accessTokenTtlSeconds * 1000);
      const refreshExpiresAt = new Date(now.getTime() + refreshTokenTtlSeconds * 1000);

      await OAuthAccessToken.create({
        ...accessMeta,
        clientId,
        userId: authCode.userId,
        scopes: authCode.scopes,
        issuedAt: now,
        expiresAt: accessExpiresAt,
      });

      await OAuthRefreshToken.create({
        ...refreshMeta,
        clientId,
        userId: authCode.userId,
        scopes: authCode.scopes,
        issuedAt: now,
        expiresAt: refreshExpiresAt,
      });

      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: accessTokenTtlSeconds,
        refresh_token: refreshToken,
        scope: formatScope(authCode.scopes),
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = getRequestBodyValue(req, 'refresh_token');
      if (!refreshToken) {
        sendTokenError(res, 400, 'invalid_request', 'Missing refresh_token.');
        return;
      }

      const refreshHash = hashToken(refreshToken);
      const storedRefresh = await OAuthRefreshToken.findActiveByHash(refreshHash);
      if (!storedRefresh) {
        sendTokenError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired.');
        return;
      }

      if (storedRefresh.clientId !== clientId) {
        sendTokenError(res, 400, 'invalid_grant', 'Refresh token does not match client.');
        return;
      }

      storedRefresh.rotatedAt = new Date();
      await storedRefresh.save();

      const { accessTokenTtlSeconds, refreshTokenTtlSeconds } = getOAuthConfig();
      const accessToken = generateOAuthAccessToken();
      const newRefreshToken = generateOAuthRefreshToken();

      const accessMeta = getTokenMetadata(accessToken);
      const refreshMeta = getTokenMetadata(newRefreshToken);

      const now = new Date();
      const accessExpiresAt = new Date(now.getTime() + accessTokenTtlSeconds * 1000);
      const refreshExpiresAt = new Date(now.getTime() + refreshTokenTtlSeconds * 1000);

      await OAuthAccessToken.create({
        ...accessMeta,
        clientId,
        userId: storedRefresh.userId,
        scopes: storedRefresh.scopes,
        issuedAt: now,
        expiresAt: accessExpiresAt,
      });

      await OAuthRefreshToken.create({
        ...refreshMeta,
        clientId,
        userId: storedRefresh.userId,
        scopes: storedRefresh.scopes,
        issuedAt: now,
        expiresAt: refreshExpiresAt,
      });

      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: accessTokenTtlSeconds,
        refresh_token: newRefreshToken,
        scope: formatScope(storedRefresh.scopes),
      });
      return;
    }

    sendTokenError(res, 400, 'unsupported_grant_type', 'Unsupported grant_type.');
  });

  app.post('/tool/oauth/register', async (req, res) => {
    const oauthConfig = getOAuthConfig();
    if (!oauthConfig.allowDynamicClientRegistration) {
      res.status(403).json({ error: 'access_denied', error_description: 'Registration disabled.' });
      return;
    }

    const redirectUris = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris.filter((value: unknown) => typeof value === 'string')
      : null;
    const clientName = pickString(req.body?.client_name) ?? null;
    const grantTypes = Array.isArray(req.body?.grant_types)
      ? req.body.grant_types.filter((value: unknown) => typeof value === 'string')
      : ['authorization_code', 'refresh_token'];
    const requestedAuthMethod = pickString(req.body?.token_endpoint_auth_method) ?? 'none';

    if (!redirectUris || redirectUris.length === 0) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uris required.' });
      return;
    }

    if (!isValidAuthMethod(requestedAuthMethod)) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'Unsupported auth method.' });
      return;
    }

    await initializePostgreSQL();

    const clientId = generateOAuthClientId();
    const secret = requestedAuthMethod === 'none' ? null : generateOAuthClientSecret();
    const secretMeta = secret ? getTokenMetadata(secret) : null;

    await OAuthClient.create({
      clientId,
      clientSecretHash: secret ? hashToken(secret) : null,
      clientSecretPrefix: secretMeta?.tokenPrefix ?? null,
      clientSecretLast4: secretMeta?.tokenLast4 ?? null,
      clientName,
      redirectUris,
      grantTypes,
      tokenEndpointAuthMethod: requestedAuthMethod,
      createdAt: new Date(),
    });

    res.status(201).json({
      client_id: clientId,
      client_secret: secret ?? undefined,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: requestedAuthMethod,
      client_name: clientName ?? undefined,
    });
  });

  app.get('/tool/oauth/callback', (req, res) => {
    const code = pickString(req.query.code);
    const state = pickString(req.query.state);
    const error = pickString(req.query.error);
    const errorDescription = pickString(req.query.error_description);

    let details = '';
    if (error) {
      details = `<p class="form-error">${escapeHtml(errorDescription ?? error)}</p>`;
    } else if (code) {
      details = `<p class="form-help">Authorization code:</p>
  <div class="token-display">${escapeHtml(code)}</div>`;
    } else {
      details = `<p class="form-help">No authorization code returned.</p>`;
    }

    const stateHtml = state
      ? `<p class="form-help">State: <code>${escapeHtml(state)}</code></p>`
      : '';

    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <h2>OAuth callback</h2>
    ${details}
    ${stateHtml}
  </div>
</div>`;

    res.type('html').send(renderOAuthLayout('OAuth callback', bodyHtml));
  });
};
