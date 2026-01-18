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
