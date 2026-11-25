import crypto from 'node:crypto';
import config from 'config';

import { hashToken } from './tokens.js';

export type OAuthConfig = {
  authorizationCodeTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  allowDynamicClientRegistration: boolean;
  defaultScopes: string[];
  issuerUrl?: string;
  resourceServerUrl?: string;
  resourceName?: string;
};

const defaultConfig: OAuthConfig = {
  authorizationCodeTtlSeconds: 600,
  accessTokenTtlSeconds: 28800,
  refreshTokenTtlSeconds: 1209600,
  allowDynamicClientRegistration: true,
  defaultScopes: ['mcp.read', 'mcp.write'],
};

export const getOAuthConfig = (): OAuthConfig => {
  if (typeof config.has === 'function' && config.has('oauth')) {
    return config.get<OAuthConfig>('oauth');
  }
  return defaultConfig;
};

const base64UrlEncode = (input: Buffer) =>
  input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

export const computeCodeChallenge = (verifier: string) => {
  const digest = crypto.createHash('sha256').update(verifier).digest();
  return base64UrlEncode(digest);
};

export const verifyPkceChallenge = (
  verifier: string,
  challenge: string,
  method: string
): boolean => {
  if (method === 'S256') {
    return computeCodeChallenge(verifier) === challenge;
  }
  if (method === 'plain') {
    return verifier === challenge;
  }
  return false;
};

export const generateOAuthClientId = () => `agp_client_${crypto.randomBytes(18).toString('hex')}`;
export const generateOAuthClientSecret = () =>
  `agp_secret_${crypto.randomBytes(24).toString('hex')}`;
export const generateOAuthCode = () => `agp_code_${crypto.randomBytes(24).toString('hex')}`;
export const generateOAuthAccessToken = () => `agp_oat_${crypto.randomBytes(24).toString('hex')}`;
export const generateOAuthRefreshToken = () => `agp_ort_${crypto.randomBytes(24).toString('hex')}`;

export const getTokenMetadata = (token: string) => ({
  tokenHash: hashToken(token),
  tokenPrefix: token.slice(0, 8),
  tokenLast4: token.slice(-4),
});

export const parseScopeParam = (value?: string | null) => {
  if (!value) return [];
  return value.split(/\s+/).map(entry => entry.trim()).filter(Boolean);
};

export const formatScope = (scopes: string[]) => scopes.join(' ');

export const resolveScopes = (requestedScopes: string[]) => {
  if (requestedScopes.length) return requestedScopes;
  return getOAuthConfig().defaultScopes;
};

export const hashClientSecret = (secret: string) => hashToken(secret);

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

type RequestOrigin = {
  protocol: string;
  get(name: string): string | undefined;
};

export const getIssuerUrl = (req: RequestOrigin) => {
  const oauthConfig = getOAuthConfig();
  if (oauthConfig.issuerUrl) return new URL(oauthConfig.issuerUrl);
  const host = req.get('host');
  if (!host) {
    throw new Error('Missing Host header.');
  }
  return new URL(`${req.protocol}://${host}`);
};

export const getResourceServerUrl = (issuer: URL) => {
  const oauthConfig = getOAuthConfig();
  if (oauthConfig.resourceServerUrl) return new URL(oauthConfig.resourceServerUrl);
  return new URL('/mcp', issuer.origin);
};

export const getProtectedResourceMetadataUrl = (issuer: URL) =>
  new URL(PROTECTED_RESOURCE_METADATA_PATH, issuer.origin);

const quoteAuthParam = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`;

// RFC 6750 §3 and RFC 9728 §5.1: clients discover the authorization server
// from resource_metadata, so every 401 from the resource server carries it.
export const buildBearerChallenge = ({
  resourceMetadataUrl,
  scopes,
  error,
}: {
  resourceMetadataUrl: URL;
  scopes: string[];
  error?: 'invalid_token';
}) => {
  const params = [`resource_metadata=${quoteAuthParam(resourceMetadataUrl.href)}`];
  if (scopes.length) params.push(`scope=${quoteAuthParam(formatScope(scopes))}`);
  if (error) params.push(`error=${quoteAuthParam(error)}`);
  return `Bearer ${params.join(', ')}`;
};
