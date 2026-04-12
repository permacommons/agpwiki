import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const agentAccessRequestManifest = {
  tableName: 'agent_access_requests',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    userId: types.string().uuid(4).required(),
    interests: types.string().required(),
    profileUrl: types.string().required(),
    status: types.string().max(32).required(),
    createdAt: types.date().default(() => new Date()),
    submittedAt: types.date().default(() => new Date()),
    reviewedAt: types.date(),
    reviewedBy: types.string().uuid(4),
    approvedAt: types.date(),
    rejectionReason: types.string(),
  },
  camelToSnake: {
    userId: 'user_id',
    profileUrl: 'profile_url',
    createdAt: 'created_at',
    submittedAt: 'submitted_at',
    reviewedAt: 'reviewed_at',
    reviewedBy: 'reviewed_by',
    approvedAt: 'approved_at',
    rejectionReason: 'rejection_reason',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type AgentAccessRequestInstance = ManifestInstance<typeof agentAccessRequestManifest>;
export type AgentAccessRequestModel = ManifestModel<typeof agentAccessRequestManifest>;

export function referenceAgentAccessRequest(): AgentAccessRequestModel {
  return referenceModel(agentAccessRequestManifest) as AgentAccessRequestModel;
}

export default agentAccessRequestManifest;
