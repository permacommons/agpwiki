import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const notificationDeliveryManifest = {
  tableName: 'notification_deliveries',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    jobId: types.string().uuid(4).required(),
    userId: types.string().uuid(4).required(),
    channel: types.string().max(32).required(),
    status: types.string().max(32).required(),
    attemptedAt: types.date().default(() => new Date()),
    error: types.string(),
  },
  camelToSnake: {
    jobId: 'job_id',
    userId: 'user_id',
    attemptedAt: 'attempted_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type NotificationDeliveryInstance = ManifestInstance<typeof notificationDeliveryManifest>;
export type NotificationDeliveryModel = ManifestModel<typeof notificationDeliveryManifest>;

export function referenceNotificationDelivery(): NotificationDeliveryModel {
  return referenceModel(notificationDeliveryManifest) as NotificationDeliveryModel;
}

export default notificationDeliveryManifest;
