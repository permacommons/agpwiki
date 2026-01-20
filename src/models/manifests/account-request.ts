import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { types } = dal;

const accountRequestManifest = {
  tableName: 'account_requests',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    email: types.string().max(254).required(),
    topics: types.string().required(),
    portfolio: types.string().required(),
    ipAddress: types.string().max(45),
    userAgent: types.string(),
    createdAt: types.date().default(() => new Date()),
    deletedAt: types.date(),
    deletedBy: types.string().uuid(4),
  },
  camelToSnake: {
    ipAddress: 'ip_address',
    userAgent: 'user_agent',
    createdAt: 'created_at',
    deletedAt: 'deleted_at',
    deletedBy: 'deleted_by',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type AccountRequestInstance = ManifestInstance<typeof accountRequestManifest>;
export type AccountRequestModel = ManifestModel<typeof accountRequestManifest>;

export function referenceAccountRequest(): AccountRequestModel {
  return referenceModel(accountRequestManifest) as AccountRequestModel;
}

export default accountRequestManifest;
