import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { hashToken } from '../auth/tokens.js';
import ApiToken from '../models/api-token.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export const requireAuthToken = () => {
  const token = process.env.AGPWIKI_MCP_TOKEN;
  if (!token) {
    throw new AuthError('Missing AGPWIKI_MCP_TOKEN for MCP authentication.');
  }
  return token.trim();
};

type AuthResolveOptions = {
  token?: string;
  authInfo?: AuthInfo;
};

export const verifyAuthToken = async (token: string) => {
  const tokenHash = hashToken(token);
  const record = await ApiToken.findActiveByHash(tokenHash);
  if (!record) {
    throw new AuthError('Invalid or expired MCP token.');
  }
  record.lastUsedAt = new Date();
  await record.save();
  return record;
};

export const resolveAuthUserId = async (options: AuthResolveOptions = {}) => {
  const authUser = options.authInfo?.extra?.userId;
  if (typeof authUser === 'string' && authUser) {
    return authUser;
  }
  const token = options.token ?? requireAuthToken();
  const record = await verifyAuthToken(token);
  return record.userId;
};
