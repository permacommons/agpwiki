import crypto from 'node:crypto';

export const hashToken = (token: string) =>
  crypto.createHash('sha256').update(token).digest('hex');

export const generateApiToken = () => `agp_${crypto.randomBytes(24).toString('hex')}`;

export const generateInviteCode = () => `agp_inv_${crypto.randomBytes(18).toString('hex')}`;
