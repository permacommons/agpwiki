import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { types } = dal;

const userManifest = {
  tableName: 'users',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    displayName: types.string().max(128).required(),
    email: types.string().max(254).required(),
    passwordHash: types.string().max(255).required(),
    createdAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    displayName: 'display_name',
    passwordHash: 'password_hash',
    createdAt: 'created_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type UserInstance = ManifestInstance<typeof userManifest>;
export type UserModel = ManifestModel<typeof userManifest>;

export function referenceUser(): UserModel {
  return referenceModel(userManifest) as UserModel;
}

export default userManifest;
