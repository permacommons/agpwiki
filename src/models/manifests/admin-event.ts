import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const adminEventManifest = {
  tableName: 'admin_events',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    eventType: types.string().max(64).required(),
    actorUserId: types.string().uuid(4),
    targetType: types.string().max(64).required(),
    targetId: types.string().uuid(4),
    targetRevId: types.string().uuid(4),
    details: types.object(),
    createdAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    eventType: 'event_type',
    actorUserId: 'actor_user_id',
    targetType: 'target_type',
    targetId: 'target_id',
    targetRevId: 'target_rev_id',
    createdAt: 'created_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type AdminEventInstance = ManifestInstance<typeof adminEventManifest>;
export type AdminEventModel = ManifestModel<typeof adminEventManifest>;

export function referenceAdminEvent(): AdminEventModel {
  return referenceModel(adminEventManifest) as AdminEventModel;
}

export default adminEventManifest;
