import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const pageProtectionManifest = {
  tableName: 'page_protections',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    pageId: types.string().uuid(4).required(),
    protectedAt: types.date().default(() => new Date()),
    protectedBy: types.string().uuid(4),
    reason: types.string(),
  },
  camelToSnake: {
    pageId: 'page_id',
    protectedAt: 'protected_at',
    protectedBy: 'protected_by',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type PageProtectionInstance = ManifestInstance<typeof pageProtectionManifest>;
export type PageProtectionModel = ManifestModel<typeof pageProtectionManifest>;

export function referencePageProtection(): PageProtectionModel {
  return referenceModel(pageProtectionManifest) as PageProtectionModel;
}

export default pageProtectionManifest;
