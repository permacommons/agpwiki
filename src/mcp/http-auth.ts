import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { NextFunction, Request, Response } from 'express';

import debug from '../../util/debug.js';
import {
  buildBearerChallenge,
  getIssuerUrl,
  getOAuthConfig,
  getProtectedResourceMetadataUrl,
} from '../auth/oauth.js';
import { initializePostgreSQL } from '../db.js';
import { resolveAuthInfoFromToken } from './auth.js';

const parseBearerToken = (req: Request) => {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  return value?.trim() || null;
};

const setBearerChallenge = (req: Request, res: Response, error?: 'invalid_token') => {
  try {
    const resourceMetadataUrl = getProtectedResourceMetadataUrl(getIssuerUrl(req));
    res.set(
      'WWW-Authenticate',
      buildBearerChallenge({ resourceMetadataUrl, scopes: getOAuthConfig().defaultScopes, error })
    );
  } catch (challengeError) {
    const message = challengeError instanceof Error ? challengeError.message : String(challengeError);
    debug.error(`MCP auth challenge could not be built: ${message}`);
  }
};

export const sendMissingToken = (req: Request, res: Response) => {
  setBearerChallenge(req, res);
  res.status(401).json({
    error: 'Missing Authorization header. Use: Authorization: Bearer <token>',
  });
};

export const sendInvalidToken = (req: Request, res: Response, body: unknown) => {
  setBearerChallenge(req, res, 'invalid_token');
  res.status(401).json(body);
};

export const getAuthInfo = (req: Request) => (req as Request & { auth?: AuthInfo }).auth;

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const token = parseBearerToken(req);
  if (!token) {
    sendMissingToken(req, res);
    return;
  }

  try {
    await initializePostgreSQL();
    const authInfo: AuthInfo = await resolveAuthInfoFromToken(token);

    (req as Request & { auth?: AuthInfo }).auth = authInfo;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.error(`MCP auth failed: ${message}`);
    sendInvalidToken(req, res, { error: 'Invalid or expired token.' });
    return;
  }
  next();
};
