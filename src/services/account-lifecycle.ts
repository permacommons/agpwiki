import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';

import AgentAccessRequest from '../models/agent-access-request.js';
import type { AgentAccessRequestInstance } from '../models/manifests/agent-access-request.js';
import type { UserInstance } from '../models/manifests/user.js';
import User from '../models/user.js';
import UserNoticeDismissal from '../models/user-notice-dismissal.js';

export const AGENT_ACCESS_GRANTED_NOTICE = 'agent_access_granted';
export const AGENT_ACCESS_REJECTED_NOTICE = 'agent_access_rejected';

export type AgentAccessStatus = 'none' | 'pending' | 'approved' | 'rejected';

export type AccountLifecycleState = {
  user: UserInstance;
  agentAccessRequest: AgentAccessRequestInstance | null;
  dismissedNoticeKeys: Set<string>;
  isBlocked: boolean;
  isEmailVerified: boolean;
  agentAccessStatus: AgentAccessStatus;
};

export const normalizeProfileUrl = (value: string): string | null => {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const getAgentAccessStatus = (
  request: AgentAccessRequestInstance | null
): AgentAccessStatus => {
  if (!request) return 'none';
  if (request.status === 'pending') return 'pending';
  if (request.status === 'approved') return 'approved';
  if (request.status === 'rejected') return 'rejected';
  return 'none';
};

export const revokeAllUserAccess = async (dal: DataAccessLayer, userId: string) => {
  const revokedAt = new Date();
  await Promise.all([
    dal.query(
      'UPDATE auth_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, revokedAt]
    ),
    dal.query(
      'UPDATE api_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, revokedAt]
    ),
    dal.query(
      'UPDATE oauth_access_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, revokedAt]
    ),
    dal.query(
      'UPDATE oauth_refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, revokedAt]
    ),
    // Authorization codes are short-lived single-use tokens; mark them consumed
    // here to revoke outstanding codes without adding a separate revocation path.
    dal.query(
      'UPDATE oauth_authorization_codes SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL',
      [userId, revokedAt]
    ),
  ]);
};

export const blockUserAccount = async (
  dal: DataAccessLayer,
  userId: string,
  blockedBy: string,
  blockReason: string | null = null
) => {
  const user = await User.filterWhere({ id: userId }).first();
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  user.blockedAt = new Date();
  user.blockedBy = blockedBy;
  user.blockReason = blockReason;
  await user.save();
  await revokeAllUserAccess(dal, userId);
};

export const unblockUserAccount = async (userId: string) => {
  const user = await User.filterWhere({ id: userId }).first();
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  user.blockedAt = null;
  user.blockedBy = null;
  user.blockReason = null;
  await user.save();
};

export const markUserEmailVerified = async (userId: string) => {
  const user = await User.filterWhere({ id: userId }).first();
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }
  if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
    await user.save();
  }
  return user;
};

export const upsertAgentAccessRequest = async (
  userId: string,
  interests: string,
  profileUrl: string
) => {
  const existing = await AgentAccessRequest.filterWhere({ userId }).first();
  const now = new Date();
  if (existing) {
    existing.interests = interests;
    existing.profileUrl = profileUrl;
    existing.status = 'pending';
    existing.submittedAt = now;
    existing.reviewedAt = null;
    existing.reviewedBy = null;
    existing.approvedAt = null;
    existing.rejectionReason = null;
    await existing.save();
    return existing;
  }

  return AgentAccessRequest.create({
    userId,
    interests,
    profileUrl,
    status: 'pending',
    createdAt: now,
    submittedAt: now,
  });
};

export const approveAgentAccessRequest = async (
  userId: string,
  reviewedBy: string
) => {
  const request = await AgentAccessRequest.filterWhere({ userId }).first();
  if (!request) {
    throw new Error(`Agent access request not found for user: ${userId}`);
  }

  const now = new Date();
  request.status = 'approved';
  request.reviewedAt = now;
  request.reviewedBy = reviewedBy;
  request.approvedAt = now;
  request.rejectionReason = null;
  await request.save();
  return request;
};

export const rejectAgentAccessRequest = async (
  userId: string,
  reviewedBy: string,
  rejectionReason: string
) => {
  const request = await AgentAccessRequest.filterWhere({ userId }).first();
  if (!request) {
    throw new Error(`Agent access request not found for user: ${userId}`);
  }

  request.status = 'rejected';
  request.reviewedAt = new Date();
  request.reviewedBy = reviewedBy;
  request.approvedAt = null;
  request.rejectionReason = rejectionReason;
  await request.save();
  return request;
};

export const dismissUserNotice = async (userId: string, noticeKey: string) => {
  const existing = await UserNoticeDismissal.filterWhere({ userId, noticeKey }).first();
  if (existing) return existing;
  return UserNoticeDismissal.create({
    userId,
    noticeKey,
    dismissedAt: new Date(),
  });
};

export const getAccountLifecycleState = async (
  userId: string
): Promise<AccountLifecycleState | null> => {
  const user = await User.filterWhere({ id: userId }).first();
  if (!user) return null;

  const [agentAccessRequest, dismissed] = await Promise.all([
    AgentAccessRequest.filterWhere({ userId }).first(),
    UserNoticeDismissal.filterWhere({ userId }).run(),
  ]);

  return {
    user,
    agentAccessRequest,
    dismissedNoticeKeys: new Set(dismissed.map(entry => entry.noticeKey)),
    isBlocked: Boolean(user.blockedAt),
    isEmailVerified: Boolean(user.emailVerifiedAt),
    agentAccessStatus: getAgentAccessStatus(agentAccessRequest),
  };
};

export const userCanUseAgentFeatures = (state: AccountLifecycleState) =>
  !state.isBlocked && state.isEmailVerified && state.agentAccessStatus === 'approved';
