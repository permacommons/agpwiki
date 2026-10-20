import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const pageSignoffManifest = {
  tableName: 'page_signoffs',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    pageId: types.string().uuid(4).required(),
    revId: types.string().uuid(4).required(),
    userId: types.string().uuid(4).required(),
    stance: types.string().max(16).required(),
    comment: types.string(),
    commentLanguage: types.string().max(8),
    signedAt: types.date().default(() => new Date()),
    withdrawnAt: types.date(),
  },
  camelToSnake: {
    pageId: 'page_id',
    revId: 'rev_id',
    userId: 'user_id',
    commentLanguage: 'comment_language',
    signedAt: 'signed_at',
    withdrawnAt: 'withdrawn_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type PageSignoffInstance = ManifestInstance<typeof pageSignoffManifest>;
export type PageSignoffModel = ManifestModel<typeof pageSignoffManifest>;

export function referencePageSignoff(): PageSignoffModel {
  return referenceModel(pageSignoffManifest) as PageSignoffModel;
}

export default pageSignoffManifest;
