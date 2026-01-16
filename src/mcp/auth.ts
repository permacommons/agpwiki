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

export const resolveAuthUserId = async () => {
  const token = requireAuthToken();
  const tokenHash = hashToken(token);
  const record = await ApiToken.findActiveByHash(tokenHash);
  if (!record) {
    throw new AuthError('Invalid or expired MCP token.');
  }
  if (record.lastUsedAt === null || record.lastUsedAt === undefined) {
    record.lastUsedAt = new Date();
  } else {
    record.lastUsedAt = new Date();
  }
  await record.save();
  return record.userId;
};
