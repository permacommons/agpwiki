import { generateEmailVerificationToken, hashToken } from '../auth/tokens.js';
import EmailVerificationToken from '../models/email-verification-token.js';
import type { UserInstance } from '../models/manifests/user.js';
import { escapeHtml } from '../render.js';
import { markUserEmailVerified } from './account-lifecycle.js';
import { sendMail } from './email-service.js';
import { getSiteBaseUrl } from './site-config.js';

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export const buildEmailVerificationLink = (token: string) =>
  `${getSiteBaseUrl()}/tool/confirm-email?token=${encodeURIComponent(token)}`;

export const createEmailVerificationToken = async (user: UserInstance) => {
  const token = generateEmailVerificationToken();
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

  await EmailVerificationToken.create({
    userId: user.id,
    email: user.email,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 8),
    createdAt: new Date(),
    expiresAt,
  });

  return { token, expiresAt };
};

export const sendEmailVerificationEmail = async (user: UserInstance, token: string) => {
  const confirmationUrl = buildEmailVerificationLink(token);
  const safeName = escapeHtml(user.displayName);
  const safeUrl = escapeHtml(confirmationUrl);
  return sendMail({
    to: user.email,
    subject: 'Confirm your Agpedia email address',
    text: [
      `Hello ${user.displayName},`,
      '',
      'Please confirm your email address for your Agpedia account:',
      confirmationUrl,
      '',
      'If you did not create this account, you can ignore this email.',
    ].join('\n'),
    html: `<p>Hello ${safeName},</p>
<p>Please confirm your email address for your Agpedia account:</p>
<p><a href="${safeUrl}">${safeUrl}</a></p>
<p>If you did not create this account, you can ignore this email.</p>`,
  });
};

export const verifyEmailConfirmationToken = async (token: string) => {
  const tokenHash = hashToken(token);
  const record = await EmailVerificationToken.findActiveByHash(tokenHash);
  if (!record) return null;

  record.usedAt = new Date();
  await record.save();
  const user = await markUserEmailVerified(record.userId);
  return user;
};
