import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { types } = dal;

const pageAliasManifest = {
  tableName: 'page_aliases',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    pageId: types.string().uuid(4).required(),
    slug: types.string().max(200).required(),
    lang: types.string().max(8),
    createdAt: types.date().default(() => new Date()),
    updatedAt: types.date().default(() => new Date()),
    createdBy: types.string().uuid(4),
  },
  camelToSnake: {
    pageId: 'page_id',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    createdBy: 'created_by',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type PageAliasInstance = ManifestInstance<typeof pageAliasManifest>;
export type PageAliasModel = ManifestModel<typeof pageAliasManifest>;

export function referencePageAlias(): PageAliasModel {
  return referenceModel(pageAliasManifest) as PageAliasModel;
}

export default pageAliasManifest;
