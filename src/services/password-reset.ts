import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';

import { hashPassword } from '../auth/password.js';
import { generatePasswordResetToken, hashToken } from '../auth/tokens.js';
import { normalizeUsername } from '../lib/username.js';
import PasswordResetToken from '../models/password-reset-token.js';
import User from '../models/user.js';
import { escapeHtml } from '../render.js';
import { revokeAllUserAccess } from './account-lifecycle.js';
import { sendMail } from './email-service.js';
import { getSiteBaseUrl } from './site-config.js';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export const buildPasswordResetLink = (token: string) =>
  `${getSiteBaseUrl()}/tool/reset-password/confirm?token=${encodeURIComponent(token)}`;

export const createPasswordResetToken = async (user: {
  id: string;
  email: string;
}) => {
  const token = generatePasswordResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  await PasswordResetToken.create({
    userId: user.id,
    email: user.email,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 8),
    createdAt: new Date(),
    expiresAt,
  });

  return { token, expiresAt };
};

export const sendPasswordResetEmail = async (
  user: { displayName: string; email: string },
  token: string
) => {
  const resetUrl = buildPasswordResetLink(token);
  const safeName = escapeHtml(user.displayName);
  const safeUrl = escapeHtml(resetUrl);
  return sendMail({
    to: user.email,
    subject: 'Reset your Agpedia password',
    text: [
      `Hello ${user.displayName},`,
      '',
      'Use this link to reset the password for your Agpedia account:',
      resetUrl,
      '',
      'If you did not request a password reset, you can ignore this email.',
    ].join('\n'),
    html: `<p>Hello ${safeName},</p>
<p>Use this link to reset the password for your Agpedia account:</p>
<p><a href="${safeUrl}">${safeUrl}</a></p>
<p>If you did not request a password reset, you can ignore this email.</p>`,
  });
};

export const findPasswordResetUser = async (identifier: string) => {
  const trimmed = identifier.trim();
  if (!trimmed) return null;

  if (trimmed.includes('@')) {
    return User.filterWhere({ email: trimmed.toLowerCase() }).first();
  }

  const username = normalizeUsername(trimmed);
  return username ? User.filterWhere({ username }).first() : null;
};

export const requestPasswordReset = async (identifier: string) => {
  const user = await findPasswordResetUser(identifier);
  if (!user || user.blockedAt) {
    return { requested: false as const };
  }

  const { token, expiresAt } = await createPasswordResetToken(user);
  const delivery = await sendPasswordResetEmail(user, token);
  return {
    requested: true as const,
    delivered: delivery.delivered,
    skipped: delivery.skipped,
    expiresAt,
  };
};

export const verifyPasswordResetToken = async (token: string) => {
  const tokenHash = hashToken(token);
  return PasswordResetToken.findActiveByHash(tokenHash);
};

export const resetPasswordWithToken = async (
  dal: DataAccessLayer,
  token: string,
  password: string
) => {
  const tokenHash = hashToken(token);
  const usedAt = new Date();
  const claimResult = await dal.query(
    `UPDATE password_reset_tokens
     SET used_at = $2
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > $2
     RETURNING user_id`,
    [tokenHash, usedAt]
  );
  const userId = claimResult.rows[0]?.user_id;
  if (typeof userId !== 'string') return null;

  const user = await User.filterWhere({ id: userId }).first();
  if (!user || user.blockedAt) return null;

  user.passwordHash = await hashPassword(password);
  await user.save();

  await dal.query(
    'UPDATE password_reset_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL',
    [user.id, usedAt]
  );
  await revokeAllUserAccess(dal, user.id);

  return user;
};
