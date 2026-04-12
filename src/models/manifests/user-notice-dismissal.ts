import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const userNoticeDismissalManifest = {
  tableName: 'user_notice_dismissals',
  hasRevisions: false as const,
  schema: {
    userId: types.string().uuid(4).required(),
    noticeKey: types.string().max(64).required(),
    dismissedAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    userId: 'user_id',
    noticeKey: 'notice_key',
    dismissedAt: 'dismissed_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type UserNoticeDismissalInstance = ManifestInstance<typeof userNoticeDismissalManifest>;
export type UserNoticeDismissalModel = ManifestModel<typeof userNoticeDismissalManifest>;

export function referenceUserNoticeDismissal(): UserNoticeDismissalModel {
  return referenceModel(userNoticeDismissalManifest) as UserNoticeDismissalModel;
}

export default userNoticeDismissalManifest;
