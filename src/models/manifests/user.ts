import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const userManifest = {
  tableName: 'users',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    username: types.string().max(128).required(),
    displayName: types.string().max(128).required(),
    email: types.string().max(254).required(),
    passwordHash: types.string().max(255).required(),
    createdAt: types.date().default(() => new Date()),
    emailVerifiedAt: types.date(),
    blockedAt: types.date(),
    blockedBy: types.string().uuid(4),
    blockReason: types.string(),
  },
  camelToSnake: {
    username: 'username',
    displayName: 'display_name',
    passwordHash: 'password_hash',
    createdAt: 'created_at',
    emailVerifiedAt: 'email_verified_at',
    blockedAt: 'blocked_at',
    blockedBy: 'blocked_by',
    blockReason: 'block_reason',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type UserInstance = ManifestInstance<typeof userManifest>;
export type UserModel = ManifestModel<typeof userManifest>;

export function referenceUser(): UserModel {
  return referenceModel(userManifest) as UserModel;
}

export default userManifest;
