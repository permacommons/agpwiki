import { randomBytes } from 'node:crypto';

import AgentAccessRequest from '../src/models/agent-access-request.js';
import User from '../src/models/user.js';

export const uniqueSuffix = () => `${Date.now()}-${randomBytes(6).toString('hex')}`;

type TestUserOptions = {
  prefix: string;
  displayName?: string;
  emailVerified?: boolean;
  // An approved agent access request is what lets a user edit without review
  // (e.g. restore revisions); some rules also depend on how long ago it was approved.
  approvedAt?: Date;
};

export const insertTestUser = async ({
  prefix,
  displayName,
  emailVerified = false,
  approvedAt,
}: TestUserOptions) => {
  const suffix = uniqueSuffix();
  const now = new Date();
  const user = await User.create({
    username: `${prefix}${suffix}`,
    displayName: displayName ?? `${prefix} ${suffix.slice(-4)}`,
    email: `${prefix}-${suffix}@example.com`,
    passwordHash: randomBytes(32).toString('hex'),
    createdAt: now,
    ...(emailVerified ? { emailVerifiedAt: now } : {}),
  });
  if (approvedAt) {
    await AgentAccessRequest.create({
      userId: user.id,
      interests: 'Testing',
      profileUrl: 'https://example.com/profile',
      status: 'approved',
      createdAt: now,
      submittedAt: now,
      reviewedAt: now,
      approvedAt,
    });
  }
  return user;
};
