import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const pageSignoffReplyManifest = {
  tableName: 'page_signoff_replies',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    signoffId: types.string().uuid(4).required(),
    pageId: types.string().uuid(4).required(),
    userId: types.string().uuid(4).required(),
    body: types.string().required(),
    bodyLanguage: types.string().max(8).required(),
    createdAt: types.date().default(() => new Date()),
    updatedAt: types.date(),
    deletedAt: types.date(),
    hiddenAt: types.date(),
    hiddenBy: types.string().uuid(4),
  },
  camelToSnake: {
    signoffId: 'signoff_id',
    pageId: 'page_id',
    userId: 'user_id',
    bodyLanguage: 'body_language',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    deletedAt: 'deleted_at',
    hiddenAt: 'hidden_at',
    hiddenBy: 'hidden_by',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type PageSignoffReplyInstance = ManifestInstance<typeof pageSignoffReplyManifest>;
export type PageSignoffReplyModel = ManifestModel<typeof pageSignoffReplyManifest>;

export function referencePageSignoffReply(): PageSignoffReplyModel {
  return referenceModel(pageSignoffReplyManifest) as PageSignoffReplyModel;
}

export default pageSignoffReplyManifest;
