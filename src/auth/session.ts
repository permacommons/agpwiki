import crypto from 'node:crypto';
import type { Request, Response } from 'express';

import AuthSession from '../models/auth-session.js';

const SESSION_COOKIE = 'agpwiki_session';
const SESSION_DAYS = 30;

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const parseCookies = (header: string | undefined) => {
  const result: Record<string, string> = {};
  if (!header) return result;
  const parts = header.split(';');
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rest.join('='));
  }
  return result;
};

const buildCookie = (value: string, expiresAt: Date) => {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
};

export const createSession = async (userId: string) => {
  const token = `agp_sess_${crypto.randomBytes(24).toString('hex')}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, 8);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await AuthSession.create({
    userId,
    tokenHash,
    tokenPrefix,
    createdAt: new Date(),
    expiresAt,
  });

  return { token, expiresAt };
};

export const setSessionCookie = (res: Response, token: string, expiresAt: Date) => {
  res.setHeader('Set-Cookie', buildCookie(token, expiresAt));
};

export const clearSessionCookie = (res: Response) => {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
};

export const resolveSessionUser = async (req: Request) => {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const tokenHash = hashToken(raw);
  const session = await AuthSession.findActiveByHash(tokenHash);
  if (!session) return null;
  session.lastUsedAt = new Date();
  await session.save();
  return { userId: session.userId, sessionId: session.id };
};

export const revokeSession = async (token: string) => {
  const tokenHash = hashToken(token);
  const session = await AuthSession.findActiveByHash(tokenHash);
  if (!session) return;
  session.revokedAt = new Date();
  await session.save();
};

export const getSessionToken = (req: Request) => {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE];
};
