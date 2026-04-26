import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const notificationJobManifest = {
  tableName: 'notification_jobs',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    type: types.string().max(64).required(),
    payload: types.object().required(),
    status: types.string().max(32).required(),
    availableAt: types.date().default(() => new Date()),
    lockedAt: types.date(),
    lockToken: types.string().uuid(4),
    attemptCount: types.number().default(() => 0),
    lastError: types.string(),
    createdAt: types.date().default(() => new Date()),
    processedAt: types.date(),
  },
  camelToSnake: {
    availableAt: 'available_at',
    lockedAt: 'locked_at',
    lockToken: 'lock_token',
    attemptCount: 'attempt_count',
    lastError: 'last_error',
    createdAt: 'created_at',
    processedAt: 'processed_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type NotificationJobInstance = ManifestInstance<typeof notificationJobManifest>;
export type NotificationJobModel = ManifestModel<typeof notificationJobManifest>;

export function referenceNotificationJob(): NotificationJobModel {
  return referenceModel(notificationJobManifest) as NotificationJobModel;
}

export default notificationJobManifest;
